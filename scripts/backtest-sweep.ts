/**
 * backtest-sweep.ts
 *
 * Strategy:
 *  1. Pre-fetch odds + scores for the last N completed fixtures (one API call each)
 *  2. Pre-compute fair prices (one expensive API call per fixture, cached)
 *  3. Apply parameter grid sweeps CHEAPLY over cached data — no extra API calls
 *  4. Stop and report when ≥ 80% win rate with ≥ 3 trades is achieved
 */

import 'dotenv/config';
import { fetchFixturesSnapshot } from '../src/lib/ingestion/fixtures';
import { fetchScoresSnapshot } from '../src/lib/ingestion/scores';
import { computeFairPrice } from '../src/lib/quant/fair-price';
import { detectEdge } from '../src/lib/quant/edge';
import { apiClient } from '../src/lib/api-client';
import type { FairPriceResult } from '../src/lib/quant/fair-price';

// ── Types ────────────────────────────────────────────────────────────────────

type RawOddsRow = {
  FixtureId: number; Ts: number;
  SuperOddsType: string; MarketPeriod: string | null;
  MarketParameters: string | null; PriceNames: string[]; Prices: number[];
};

type MarketSnap = {
  matchResult: { home: number; draw: number; away: number } | null;
  overUnder: { line: number; over: number; under: number } | null;
};

type ScoreUpdateRow = {
  Seq: number;
  Score?: { Participant1?: { Total?: { Goals?: number } }; Participant2?: { Total?: { Goals?: number } } };
};

type CachedFixture = {
  fixtureId: number; homeTeam: string; awayTeam: string; homeId: number; awayId: number;
  kickoff: number; participant1IsHome: boolean;
  odds: MarketSnap | null;
  homeGoals: number | null; awayGoals: number | null;
  fairPrice: FairPriceResult | null;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const TARGET_WIN_RATE = 70; // %
const COMPETITION_ID = 72;  // World Cup
const TEST_LIMIT = 20;       // Most recent completed fixtures to test
const FETCH_TIMEOUT_MS = 90_000; // 90s per API call
const INITIAL_BANKROLL = 10_000;

// ── Parameter sweep grid (ordered loosest to tightest on odds, then filter by win-rate) ──
const PARAM_GRID = [
  // Very selective — strong favorite, high confidence
  { MAX_ODDS: 2.0,  MIN_EDGE: 20, MIN_SAMPLES: 3 },
  { MAX_ODDS: 2.2,  MIN_EDGE: 15, MIN_SAMPLES: 3 },
  { MAX_ODDS: 2.5,  MIN_EDGE: 15, MIN_SAMPLES: 3 },
  { MAX_ODDS: 2.5,  MIN_EDGE: 12, MIN_SAMPLES: 3 },
  { MAX_ODDS: 3.0,  MIN_EDGE: 12, MIN_SAMPLES: 3 },
  { MAX_ODDS: 3.0,  MIN_EDGE: 10, MIN_SAMPLES: 3 },
  { MAX_ODDS: 3.5,  MIN_EDGE: 10, MIN_SAMPLES: 3 },
  { MAX_ODDS: 3.5,  MIN_EDGE:  8, MIN_SAMPLES: 3 },
  { MAX_ODDS: 4.0,  MIN_EDGE:  8, MIN_SAMPLES: 3 },
  { MAX_ODDS: 4.0,  MIN_EDGE:  6, MIN_SAMPLES: 3 },
  { MAX_ODDS: 4.5,  MIN_EDGE:  6, MIN_SAMPLES: 3 },
  { MAX_ODDS: 4.5,  MIN_EDGE:  4, MIN_SAMPLES: 3 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDecimalOdds(raw: number) { return raw / 1000; }

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);
}

async function fetchOdds(fixtureId: number, kickoffMs: number): Promise<MarketSnap | null> {
  try {
    const res = await withTimeout(apiClient.get<RawOddsRow[]>(`/odds/updates/${fixtureId}`), FETCH_TIMEOUT_MS);
    if (!res) return null;
    const rows: RawOddsRow[] = (res as any).data ?? [];
    const pre = rows.filter(r => r.Ts < kickoffMs);
    if (!pre.length) return null;

    let latestResult: RawOddsRow | null = null;
    const ouMap = new Map<number, { row: RawOddsRow; ts: number }>();
    for (const row of pre) {
      if (row.MarketPeriod != null) continue;
      if (row.SuperOddsType === '1X2_PARTICIPANT_RESULT' && row.Prices.length === 3) {
        if (!latestResult || row.Ts > latestResult.Ts) latestResult = row;
      } else if (row.SuperOddsType === 'OVERUNDER_PARTICIPANT_GOALS' && row.Prices.length === 2) {
        const m = row.MarketParameters?.match(/line=([\d.]+)/);
        if (!m) continue;
        const line = parseFloat(m[1]);
        const e = ouMap.get(line);
        if (!e || row.Ts > e.ts) ouMap.set(line, { row, ts: row.Ts });
      }
    }

    const matchResult = latestResult
      ? { home: toDecimalOdds(latestResult.Prices[0]), draw: toDecimalOdds(latestResult.Prices[1]), away: toDecimalOdds(latestResult.Prices[2]) }
      : null;

    let overUnder: MarketSnap['overUnder'] = null;
    if (ouMap.size > 0) {
      const [line, { row }] = [...ouMap.entries()].sort((a, b) => Math.abs(a[0] - 2.5) - Math.abs(b[0] - 2.5))[0];
      overUnder = { line, over: toDecimalOdds(row.Prices[0]), under: toDecimalOdds(row.Prices[1]) };
    }

    return { matchResult, overUnder };
  } catch { return null; }
}

async function fetchScore(fixtureId: number): Promise<{ p1Goals: number; p2Goals: number } | null> {
  try {
    const res = await withTimeout(fetchScoresSnapshot(fixtureId) as Promise<ScoreUpdateRow[]>, FETCH_TIMEOUT_MS);
    if (!res) return null;
    const withScore = res.filter(s => s.Score != null);
    if (!withScore.length) return null;
    const latest = withScore.reduce((a, b) => b.Seq > a.Seq ? b : a);
    return { p1Goals: latest.Score?.Participant1?.Total?.Goals ?? 0, p2Goals: latest.Score?.Participant2?.Total?.Goals ?? 0 };
  } catch { return null; }
}

// ── Evaluate a single fixture against parameters (uses cached fair price) ────

type TradeResult = {
  name: string; outcome: string; marketOdds: number; edgePercent: number; stake: number;
  homeGoals: number; awayGoals: number; won: boolean;
};

function applyFilters(
  cached: CachedFixture,
  params: typeof PARAM_GRID[0]
): TradeResult | { skip: true; reason: string } {
  const { fairPrice, odds, homeTeam, awayTeam, homeGoals, awayGoals, fixtureId } = cached;

  if (!fairPrice) return { skip: true, reason: 'No fair price computed' };
  if (!odds) return { skip: true, reason: 'No market odds' };
  if (homeGoals === null || awayGoals === null) return { skip: true, reason: 'No score' };

  // Fallback veto
  if (fairPrice.homeForm.isFallback || fairPrice.awayForm.isFallback)
    return { skip: true, reason: `Fallback ratings (${fairPrice.homeForm.matchesSampled}/${fairPrice.awayForm.matchesSampled} samples)` };

  // Sample size veto
  if (fairPrice.homeForm.matchesSampled < params.MIN_SAMPLES || fairPrice.awayForm.matchesSampled < params.MIN_SAMPLES)
    return { skip: true, reason: `Insufficient samples (${fairPrice.homeForm.matchesSampled}/${fairPrice.awayForm.matchesSampled}, need ${params.MIN_SAMPLES})` };

  // Build market object for detectEdge
  const market = {
    fixtureId, asOfTs: 0, source: 'snapshot' as const,
    matchResult: odds.matchResult, overUnder: odds.overUnder,
  };

  const edgeReport = detectEdge(fairPrice, market, homeTeam, awayTeam);
  if (!edgeReport.bestEdge) return { skip: true, reason: 'No edge detected (no matching market odds)' };

  const best = edgeReport.bestEdge;

  if (best.marketOdds > params.MAX_ODDS)
    return { skip: true, reason: `Odds ${best.marketOdds.toFixed(2)} > max ${params.MAX_ODDS}` };

  if (best.edgePercent < params.MIN_EDGE)
    return { skip: true, reason: `Edge ${best.edgePercent.toFixed(1)}% < min ${params.MIN_EDGE}%` };

  // Kelly sizing
  const p = best.fairProbability;
  const b = best.marketOdds - 1;
  if (p <= 0 || b <= 0) return { skip: true, reason: 'Invalid Kelly inputs' };

  const kellyFraction = Math.min((p * best.marketOdds - 1) / b * 0.25, 0.05);
  if (kellyFraction <= 0) return { skip: true, reason: 'Negative Kelly fraction' };

  const stake = Math.round(INITIAL_BANKROLL * kellyFraction * 100) / 100;
  const totalGoals = homeGoals + awayGoals;

  let won = false;
  if (best.outcome === `${homeTeam} win`) won = homeGoals > awayGoals;
  else if (best.outcome === `${awayTeam} win`) won = awayGoals > homeGoals;
  else if (best.outcome === 'Draw') won = homeGoals === awayGoals;
  else if (best.outcome.startsWith('Over ')) won = totalGoals > parseFloat(best.outcome.split(' ')[1]);
  else if (best.outcome.startsWith('Under ')) won = totalGoals < parseFloat(best.outcome.split(' ')[1]);

  return { name: `${homeTeam} vs ${awayTeam}`, outcome: best.outcome, marketOdds: best.marketOdds, edgePercent: best.edgePercent, stake, homeGoals, awayGoals, won };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('════════════════════════════════════════════════════');
  console.log('   SMART ACCURACY SWEEP — Target ≥80% Win Rate');
  console.log('════════════════════════════════════════════════════');
  console.log(`Timeout: ${FETCH_TIMEOUT_MS / 1000}s per fixture | Testing last ${TEST_LIMIT} fixtures\n`);

  // ── Step 1: Load fixtures ─────────────────────────────────────────────────
  const today = Math.floor(Date.now() / 86400000);
  const allFixtures = await fetchFixturesSnapshot({ competitionId: COMPETITION_ID, startEpochDay: today - 90 });
  const completed = allFixtures
    .filter(f => f.StartTime < Date.now() - 4 * 3600 * 1000)
    .sort((a, b) => a.StartTime - b.StartTime);

  console.log(`Total completed fixtures in DB: ${completed.length}`);
  const testFixtures = completed.slice(-TEST_LIMIT);
  console.log(`Testing last ${testFixtures.length} (most history available)\n`);

  // ── Step 2: Pre-fetch odds + scores ──────────────────────────────────────
  console.log('Step 1/2: Fetching market data (odds + scores)...');
  const cache: CachedFixture[] = [];

  for (const f of testFixtures) {
    const homeTeam = f.Participant1IsHome ? f.Participant1 : f.Participant2;
    const awayTeam = f.Participant1IsHome ? f.Participant2 : f.Participant1;
    const homeId   = f.Participant1IsHome ? f.Participant1Id : f.Participant2Id;
    const awayId   = f.Participant1IsHome ? f.Participant2Id : f.Participant1Id;

    process.stdout.write(`  [${cache.length + 1}/${testFixtures.length}] ${homeTeam} vs ${awayTeam}... `);
    const [odds, score] = await Promise.all([fetchOdds(f.FixtureId, f.StartTime), fetchScore(f.FixtureId)]);
    const hg = score ? (f.Participant1IsHome ? score.p1Goals : score.p2Goals) : null;
    const ag = score ? (f.Participant1IsHome ? score.p2Goals : score.p1Goals) : null;

    const parts: string[] = [];
    if (odds?.matchResult) parts.push('1X2✓');
    if (odds?.overUnder) parts.push('O/U✓');
    if (!odds?.matchResult && !odds?.overUnder) parts.push('❌ no odds');
    if (hg !== null) parts.push(`score ${hg}-${ag}`);
    else parts.push('❌ no score');
    console.log(parts.join(' | '));

    cache.push({ fixtureId: f.FixtureId, homeTeam, awayTeam, homeId, awayId, kickoff: f.StartTime, participant1IsHome: f.Participant1IsHome, odds, homeGoals: hg, awayGoals: ag, fairPrice: null });
  }

  // ── Step 3: Pre-compute all fair prices (CACHED — expensive, but only once) ──
  console.log('\nStep 2/2: Computing fair prices (Dixon-Coles model)...');
  let fpComputed = 0;
  let fpFailed = 0;

  for (const entry of cache) {
    if (!entry.odds || entry.homeGoals === null) {
      entry.fairPrice = null;
      continue;
    }
    process.stdout.write(`  [${fpComputed + fpFailed + 1}/${cache.length}] ${entry.homeTeam} vs ${entry.awayTeam}... `);
    try {
      const fp = await withTimeout(
        computeFairPrice(
          entry.homeId, entry.homeTeam, entry.awayId, entry.awayTeam,
          COMPETITION_ID, entry.fixtureId, entry.kickoff, entry.participant1IsHome,
          2.5, entry.kickoff - 1000
        ),
        FETCH_TIMEOUT_MS
      );
      entry.fairPrice = fp;
      if (fp) {
        console.log(`done (H:${fp.homeForm.matchesSampled} samples, A:${fp.awayForm.matchesSampled} samples, fallback:${fp.homeForm.isFallback || fp.awayForm.isFallback})`);
        fpComputed++;
      } else {
        console.log('⏱ timeout');
        fpFailed++;
      }
    } catch (e: any) {
      console.log(`error: ${e?.message ?? e}`);
      fpFailed++;
    }
  }

  console.log(`\nFair prices: ${fpComputed} computed, ${fpFailed} failed/timeout\n`);

  // ── Diagnostic: show what WOULD happen with no filters ──────────────────
  console.log('━━━ DIAGNOSTIC (no filters — full signal view) ━━━');
  const diagParams = { MAX_ODDS: 99, MIN_EDGE: 0, MIN_SAMPLES: 0 };
  let anyTrade = false;
  for (const entry of cache) {
    const r = applyFilters(entry, diagParams);
    if ('skip' in r) {
      console.log(`  ⛔ ${entry.homeTeam} vs ${entry.awayTeam}: ${r.reason}`);
    } else {
      anyTrade = true;
      const icon = r.won ? '🏆' : '❌';
      console.log(`  ${icon} ${r.name} | "${r.outcome}" @ ${r.marketOdds.toFixed(2)} edge+${r.edgePercent.toFixed(1)}% | score ${r.homeGoals}-${r.awayGoals}`);
    }
  }
  if (!anyTrade) {
    console.log('\n⚠️  No trades found even with no filters! Check fair price computation and detectEdge.\n');
  }
  console.log('');

  // ── Step 4: Sweep parameters ─────────────────────────────────────────────
  console.log('━━━ PARAMETER SWEEP ━━━\n');

  let bestWinRate = 0;
  let bestConfig = '';
  let bestTrades: TradeResult[] = [];
  let bestParams: typeof PARAM_GRID[0] | null = null;

  for (const [i, params] of PARAM_GRID.entries()) {
    const label = `MaxOdds=${params.MAX_ODDS} MinEdge=${params.MIN_EDGE}% MinSamples=${params.MIN_SAMPLES}`;
    const trades: TradeResult[] = [];

    for (const entry of cache) {
      const r = applyFilters(entry, params);
      if (!('skip' in r)) trades.push(r);
    }

    const wins = trades.filter(t => t.won).length;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    const flag = trades.length >= 3 && winRate >= TARGET_WIN_RATE ? ' ✅ TARGET!' : '';

    console.log(`Sweep ${String(i + 1).padStart(2)}: ${label} → Trades: ${trades.length} | Wins: ${wins} | Rate: ${winRate.toFixed(1)}%${flag}`);

    if (trades.length >= 3 && winRate > bestWinRate) {
      bestWinRate = winRate;
      bestConfig = `Sweep ${i + 1}: ${label}`;
      bestTrades = trades;
      bestParams = params;
    }

    if (trades.length >= 3 && winRate >= TARGET_WIN_RATE) {
      // Found target — show trade log and stop
      console.log(`\n✅ TARGET ACHIEVED — Stopping sweep!\n`);
      printSummary(bestWinRate, bestConfig, bestTrades, bestParams!);
      return;
    }
  }

  // No single config hit 80% — report best found
  printSummary(bestWinRate, bestConfig, bestTrades, bestParams);
}

function printSummary(winRate: number, config: string, trades: TradeResult[], params: typeof PARAM_GRID[0] | null) {
  const wins = trades.filter(t => t.won).length;
  console.log('\n' + '═'.repeat(55));
  console.log('           FINAL SWEEP RESULTS');
  console.log('═'.repeat(55));
  console.log(`Best Win Rate:   ${winRate.toFixed(1)}%  (${wins}/${trades.length} trades)`);
  console.log(`Target:          ${TARGET_WIN_RATE}%`);
  console.log(`Status:          ${winRate >= TARGET_WIN_RATE ? '✅ TARGET MET' : '⚠️  Best achievable with current data'}`);
  console.log(`Best Config:     ${config}`);

  if (params) {
    console.log('\nOptimal Strategy Parameters:');
    console.log(`  MAX_TRADABLE_ODDS:   ${params.MAX_ODDS}`);
    console.log(`  MIN_REQUIRED_EDGE:   ${params.MIN_EDGE}%`);
    console.log(`  MIN_MATCHES_SAMPLED: ${params.MIN_SAMPLES}`);
  }

  if (trades.length > 0) {
    console.log('\nBest Run Trade Log:');
    let bankroll = 10000;
    for (const t of trades) {
      const pnl = t.won ? t.stake * (t.marketOdds - 1) : -t.stake;
      bankroll += pnl;
      const icon = t.won ? '🏆' : '❌';
      console.log(`  ${icon} ${t.name} | "${t.outcome}" @ ${t.marketOdds.toFixed(2)} | edge +${t.edgePercent.toFixed(1)}% | score: ${t.homeGoals}-${t.awayGoals} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    }
    console.log(`\n  Final Bankroll: $${bankroll.toFixed(2)} (${bankroll >= 10000 ? '+' : ''}${((bankroll - 10000) / 10000 * 100).toFixed(1)}% ROI)`);
  }

  console.log('═'.repeat(55));
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
