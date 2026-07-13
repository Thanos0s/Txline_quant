/**
 * Reads TxLINE's de-margined StablePrice odds and extracts the markets we
 * care about (full-match 1X2 result, full-match Over/Under total goals)
 * into a clean decimal-odds shape.
 *
 * Two data sources are used:
 *   1. /odds/snapshot/{fixtureId} — cheap, but only has data if a market
 *      ticked within the current 5-minute interval. Empty outside that
 *      window (very common for a match that isn't between odds updates).
 *   2. /odds/updates/{fixtureId} — the fuller live in-memory cache. Can be
 *      large for an in-play match (tens of thousands of rows across every
 *      market/period/line combination), so we do a single pass over it and
 *      keep only the latest full-match ("MarketPeriod: null") row per
 *      market we care about.
 *
 * We try (1) first since it's cheap, and only fall back to (2) if it comes
 * back empty — which is exactly the case for live in-play matches, where
 * the "current 5-minute snapshot" concept doesn't line up as cleanly as it
 * does pre-match.
 *
 * Raw TxLINE odds rows look like:
 * {
 *   SuperOddsType: "1X2_PARTICIPANT_RESULT",
 *   MarketPeriod: null,              // null = full match; "half=1" etc = period-specific
 *   PriceNames: ["part1", "draw", "part2"],
 *   Prices: [2432, 3410, 3384],      // decimal odds * 1000
 *   Pct: ["41.118", "29.326", "29.551"]  // de-margined implied probability %
 * }
 */

import { apiClient } from '../api-client';

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

export type MarketOdds = {
  fixtureId: number;
  asOfTs: number;
  source: 'snapshot' | 'live-updates' | 'none';
  matchResult: { home: number; draw: number; away: number } | null;
  overUnder: { line: number; over: number; under: number } | null;
};

function toDecimalOdds(raw: number): number {
  return raw / 1000;
}

function isFullMatch(row: RawOddsRow): boolean {
  return row.MarketPeriod == null;
}

function extractFromRows(rows: RawOddsRow[]): { matchResult: MarketOdds['matchResult']; overUnder: MarketOdds['overUnder'] } {
  // Single pass: track the latest full-match 1X2 row, and the latest
  // full-match O/U row per line, by Ts.
  let latestResult: RawOddsRow | null = null;
  const latestOuByLine = new Map<number, { row: RawOddsRow; ts: number }>();

  for (const row of rows) {
    if (!isFullMatch(row)) continue;

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

export async function fetchMarketOdds(fixtureId: number): Promise<MarketOdds> {
  // 1. Try the cheap snapshot endpoint first.
  const snapRes = await apiClient.get<RawOddsRow[]>(`/odds/snapshot/${fixtureId}`);
  const snapRows = snapRes.data ?? [];

  if (snapRows.length > 0) {
    const { matchResult, overUnder } = extractFromRows(snapRows);
    if (matchResult || overUnder) {
      return { fixtureId, asOfTs: snapRows[0]?.Ts ?? Date.now(), source: 'snapshot', matchResult, overUnder };
    }
  }

  // 2. Fall back to the live in-memory cache (covers in-play matches where
  //    the 5-minute snapshot window doesn't have a fresh tick).
  const liveRes = await apiClient.get<RawOddsRow[]>(`/odds/updates/${fixtureId}`);
  const liveRows = liveRes.data ?? [];

  if (liveRows.length === 0) {
    return { fixtureId, asOfTs: Date.now(), source: 'none', matchResult: null, overUnder: null };
  }

  const { matchResult, overUnder } = extractFromRows(liveRows);
  const asOfTs = liveRows.reduce((max, r) => Math.max(max, r.Ts), 0);

  return { fixtureId, asOfTs, source: 'live-updates', matchResult, overUnder };
}
