import 'dotenv/config';
import { fetchFixturesSnapshot } from '../src/lib/ingestion/fixtures';
import { fetchScoresSnapshot } from '../src/lib/ingestion/scores';
import { computeFairPrice } from '../src/lib/quant/fair-price';
import { evaluateStrategy } from '../src/lib/quant/strategy';
import { apiClient } from '../src/lib/api-client';

type RawOddsRow = {
  FixtureId: number;
  Ts: number;
  Bookmaker: string;
  SuperOddsType: string;
  MarketPeriod: string | null;
  MarketParameters: string | null;
  PriceNames: string[];
  Prices: number[];
  Pct: string[];
};

type MarketOdds = {
  fixtureId: number;
  asOfTs: number;
  source: 'snapshot' | 'live-updates' | 'none';
  matchResult: { home: number; draw: number; away: number } | null;
  overUnder: { line: number; over: number; under: number } | null;
};

function toDecimalOdds(raw: number): number {
  return raw / 1000;
}

function extractFromRows(rows: RawOddsRow[]): { matchResult: MarketOdds['matchResult']; overUnder: MarketOdds['overUnder'] } {
  let latestResult: RawOddsRow | null = null;
  const latestOuByLine = new Map<number, { row: RawOddsRow; ts: number }>();

  for (const row of rows) {
    if (row.MarketPeriod != null) continue; // skip period-specific odds

    if (row.SuperOddsType === '1X2_PARTICIPANT_RESULT' && row.Prices.length === 3) {
      if (!latestResult || row.Ts > latestResult.Ts) latestResult = row;
    } else if (row.SuperOddsType === 'OVERUNDER_PARTICIPANT_GOALS' && row.Prices.length === 2) {
      const lineMatch = row.MarketParameters?.match(/line=([\d.]+)/);
      if (!lineMatch) continue;
      const line = parseFloat(lineMatch[1]);
      const existing = latestOuByLine.get(line);
      if (!existing || row.Ts > existing.ts) latestOuByLine.set(line, { row, ts: row.Ts });
    }
  }

  const matchResult = latestResult
    ? { home: toDecimalOdds(latestResult.Prices[0]), draw: toDecimalOdds(latestResult.Prices[1]), away: toDecimalOdds(latestResult.Prices[2]) }
    : null;

  let overUnder: MarketOdds['overUnder'] = null;
  if (latestOuByLine.size > 0) {
    const closest = [...latestOuByLine.entries()].sort((a, b) => Math.abs(a[0] - 2.5) - Math.abs(b[0] - 2.5))[0];
    const [line, { row }] = closest;
    overUnder = { line, over: toDecimalOdds(row.Prices[0]), under: toDecimalOdds(row.Prices[1]) };
  }

  return { matchResult, overUnder };
}

async function getHistoricalPreMatchOdds(fixtureId: number, kickoffMs: number): Promise<MarketOdds | null> {
  try {
    const res = await apiClient.get<RawOddsRow[]>(`/odds/updates/${fixtureId}`);
    const rows = res.data ?? [];
    
    // Filter for odds that were recorded BEFORE kickoff
    const preMatchRows = rows.filter(r => r.Ts < kickoffMs);
    if (preMatchRows.length === 0) return null;

    const { matchResult, overUnder } = extractFromRows(preMatchRows);
    const asOfTs = preMatchRows.reduce((max, r) => Math.max(max, r.Ts), 0);

    return {
      fixtureId,
      asOfTs,
      source: 'live-updates',
      matchResult,
      overUnder
    };
  } catch {
    return null;
  }
}

type ScoreUpdateRow = {
  Seq: number;
  Score?: {
    Participant1?: { Total?: { Goals?: number } };
    Participant2?: { Total?: { Goals?: number } };
  };
};

async function getFinalScore(fixtureId: number): Promise<{ p1Goals: number; p2Goals: number } | null> {
  try {
    const scores = (await fetchScoresSnapshot(fixtureId)) as ScoreUpdateRow[];
    if (!scores || scores.length === 0) return null;

    const withScore = scores.filter(s => s.Score != null);
    if (withScore.length === 0) return null;

    const latestScore = withScore.reduce((a, b) => (b.Seq > a.Seq ? b : a));
    const p1 = latestScore.Score?.Participant1?.Total?.Goals ?? 0;
    const p2 = latestScore.Score?.Participant2?.Total?.Goals ?? 0;

    return { p1Goals: p1, p2Goals: p2 };
  } catch {
    return null;
  }
}

const COMPETITION_ID = 72; // World Cup
const INITIAL_BANKROLL = 10000;

async function runBacktest() {
  console.log('=== STARTING HISTORICAL BACKTEST ===');
  console.log(`Competition ID: ${COMPETITION_ID} (World Cup)`);
  console.log(`Initial Bankroll: $${INITIAL_BANKROLL}\n`);

  const today = Math.floor(Date.now() / 86400000);
  
  // Fetch fixtures from the last 90 days
  const fixtures = await fetchFixturesSnapshot({ competitionId: COMPETITION_ID, startEpochDay: today - 90 });
  
  // Filter for completed fixtures (kickoff > 4 hours ago) and sort chronologically
  const completedFixtures = fixtures
    .filter(f => f.StartTime < Date.now() - 4 * 3600 * 1000)
    .sort((a, b) => a.StartTime - b.StartTime);
    
  console.log(`Found ${completedFixtures.length} completed fixture(s) in the historical window.`);

  let bankroll = INITIAL_BANKROLL;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalVolume = 0;

  // Process a subset of fixtures from the END of the list (most recent, which have past match history)
  const testLimit = 15;
  const fixturesToTest = completedFixtures.slice(-testLimit);
  console.log(`Running backtest on the most recent ${fixturesToTest.length} resolved match(es) (allowing warm-up history)...\n`);

  for (const f of fixturesToTest) {
    const homeTeam = f.Participant1IsHome ? f.Participant1 : f.Participant2;
    const awayTeam = f.Participant1IsHome ? f.Participant2 : f.Participant1;
    const homeId = f.Participant1IsHome ? f.Participant1Id : f.Participant2Id;
    const awayId = f.Participant1IsHome ? f.Participant2Id : f.Participant1Id;

    console.log(`[Backtest] Analyzing: ${homeTeam} vs ${awayTeam} (Fixture #${f.FixtureId})`);

    // 1. Fetch pre-match odds (just before kickoff)
    const marketOdds = await getHistoricalPreMatchOdds(f.FixtureId, f.StartTime);
    if (!marketOdds || (!marketOdds.matchResult && !marketOdds.overUnder)) {
      console.log(` - Skipped: No pre-match market odds found.`);
      continue;
    }

    // 2. Compute lookahead-bias-free pre-match fair prices (asOf kickoff - 1s)
    const fairPrice = await computeFairPrice(
      homeId, homeTeam, awayId, awayTeam,
      COMPETITION_ID, f.FixtureId, f.StartTime, f.Participant1IsHome,
      2.5, f.StartTime - 1000
    );

    // 3. Evaluate Strategy
    const decision = evaluateStrategy(fairPrice, marketOdds, homeTeam, awayTeam, bankroll, []);
    
    if (!decision.shouldTrade || !decision.outcome) {
      console.log(` - No Trade: ${decision.reason}`);
      continue;
    }

    // 4. Fetch final score for settlement
    const score = await getFinalScore(f.FixtureId);
    if (!score) {
      console.log(` - Skipped: Could not retrieve final score.`);
      continue;
    }

    const homeGoals = f.Participant1IsHome ? score.p1Goals : score.p2Goals;
    const awayGoals = f.Participant1IsHome ? score.p2Goals : score.p1Goals;
    const totalGoals = homeGoals + awayGoals;

    // 5. Settle Bet
    let won = false;
    if (decision.outcome === `${homeTeam} win`) {
      won = homeGoals > awayGoals;
    } else if (decision.outcome === `${awayTeam} win`) {
      won = awayGoals > homeGoals;
    } else if (decision.outcome === 'Draw') {
      won = homeGoals === awayGoals;
    } else if (decision.outcome.startsWith('Over ')) {
      const line = parseFloat(decision.outcome.split(' ')[1]);
      won = totalGoals > line;
    } else if (decision.outcome.startsWith('Under ')) {
      const line = parseFloat(decision.outcome.split(' ')[1]);
      won = totalGoals < line;
    }

    totalTrades++;
    totalVolume += decision.stake;
    const odds = decision.marketOdds;
    const stake = decision.stake;
    const pnl = won ? stake * (odds - 1) : -stake;
    bankroll += pnl;

    if (won) {
      wins++;
    } else {
      losses++;
    }

    console.log(
      ` * BET PLACED: "${decision.outcome}" | stake: $${stake.toFixed(2)} | odds: ${odds.toFixed(2)} | edge: +${decision.edgePercent.toFixed(1)}%`
    );
    console.log(
      ` * SETTLED: Final Score: ${homeGoals}-${awayGoals} -> ${won ? '🏆 WON' : '❌ LOST'} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Bankroll: $${bankroll.toFixed(2)}`
    );
  }

  // Summary
  console.log('\n=======================================');
  console.log('===        BACKTEST SUMMARY         ===');
  console.log('=======================================');
  console.log(`Initial Bankroll:   $${INITIAL_BANKROLL.toFixed(2)}`);
  console.log(`Ending Bankroll:    $${bankroll.toFixed(2)}`);
  console.log(`Total PnL:          ${bankroll - INITIAL_BANKROLL >= 0 ? '+' : ''}$${(bankroll - INITIAL_BANKROLL).toFixed(2)}`);
  console.log(`Total Trades:       ${totalTrades}`);
  console.log(`Volume Traded:      $${totalVolume.toFixed(2)}`);
  console.log(`Wins / Losses:      ${wins} / ${losses} (Win Rate: ${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0}%)`);
  
  const roi = totalVolume > 0 ? ((bankroll - INITIAL_BANKROLL) / totalVolume) * 100 : 0;
  console.log(`Return on Vol (ROI): ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
  console.log('=======================================');
}

runBacktest().catch(e => console.error('Backtest error:', e));
