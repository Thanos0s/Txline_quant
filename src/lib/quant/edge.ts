/**
 * Edge detection: compares our independent Poisson fair-price model against
 * TxLINE's live de-margined StablePrice market odds, and expresses the gap
 * as a percentage "edge" plus a plain-English rationale string.
 *
 * Edge formula (standard value-betting definition):
 *   edge = (fairProbability * marketDecimalOdds) - 1
 * A positive edge means the market is offering more than our model thinks
 * the outcome is worth — a candidate value bet. A negative edge means the
 * market is offering less (the market believes the outcome is more likely
 * than our model does).
 */

import { oddsToProbability } from './poisson';
import type { FairPriceResult } from './fair-price';
import type { MarketOdds } from './market-odds';

export type OutcomeEdge = {
  outcome: string;
  fairOdds: number;
  fairProbability: number;
  marketOdds: number;
  marketImpliedProbability: number;
  edgePercent: number;
  isValueBet: boolean;
  rationale: string;
};

/** Below this, we don't call it a meaningful edge (accounts for model noise). */
const EDGE_THRESHOLD_PERCENT = 3;

function buildOutcomeEdge(
  outcome: string,
  fairOdds: number,
  fairProbability: number,
  marketOdds: number
): OutcomeEdge {
  const marketImpliedProbability = oddsToProbability(marketOdds);
  const edgeRatio = fairProbability * marketOdds - 1;
  const edgePercent = edgeRatio * 100;
  const isValueBet = edgePercent >= EDGE_THRESHOLD_PERCENT;

  const direction = edgePercent >= 0 ? '+' : '';
  const rationale =
    `${outcome}: fair price ${fairOdds.toFixed(2)} (${(fairProbability * 100).toFixed(1)}% model prob) ` +
    `vs market ${marketOdds.toFixed(2)} (${(marketImpliedProbability * 100).toFixed(1)}% implied) ` +
    `\u2192 ${direction}${edgePercent.toFixed(1)}% edge` +
    (isValueBet ? ' \u2014 value bet candidate' : '');

  return {
    outcome,
    fairOdds,
    fairProbability,
    marketOdds,
    marketImpliedProbability,
    edgePercent,
    isValueBet,
    rationale,
  };
}

export type EdgeReport = {
  fixtureId: number;
  generatedAt: number;
  matchResult: OutcomeEdge[];
  overUnder: OutcomeEdge[];
  bestEdge: OutcomeEdge | null;
  modelSummary: string;
};

export function detectEdge(
  fairPrice: FairPriceResult,
  market: MarketOdds,
  homeTeamName: string,
  awayTeamName: string
): EdgeReport {
  const matchResult: OutcomeEdge[] = [];
  const overUnder: OutcomeEdge[] = [];

  if (market.matchResult) {
    matchResult.push(
      buildOutcomeEdge(`${homeTeamName} win`, fairPrice.fairOdds.home, fairPrice.outcomeProbabilities.homeWin, market.matchResult.home),
      buildOutcomeEdge('Draw', fairPrice.fairOdds.draw, fairPrice.outcomeProbabilities.draw, market.matchResult.draw),
      buildOutcomeEdge(`${awayTeamName} win`, fairPrice.fairOdds.away, fairPrice.outcomeProbabilities.awayWin, market.matchResult.away)
    );
  }

  if (market.overUnder && market.overUnder.line === fairPrice.overUnder.line) {
    overUnder.push(
      buildOutcomeEdge(`Over ${fairPrice.overUnder.line}`, fairPrice.overUnder.fairOverOdds, fairPrice.overUnder.overProbability, market.overUnder.over),
      buildOutcomeEdge(`Under ${fairPrice.overUnder.line}`, fairPrice.overUnder.fairUnderOdds, fairPrice.overUnder.underProbability, market.overUnder.under)
    );
  }

  const all = [...matchResult, ...overUnder];
  const bestEdge = all.length > 0
    ? all.reduce((best, cur) => (cur.edgePercent > best.edgePercent ? cur : best))
    : null;

  const liveNote = fairPrice.liveState.isLive
    ? ` LIVE: score ${fairPrice.liveState.currentHomeGoals}-${fairPrice.liveState.currentAwayGoals}, ` +
      `~${Math.round(fairPrice.liveState.elapsedSeconds / 60)}' elapsed (${fairPrice.liveState.clockSource}), ` +
      `remaining-time λ scaled to ${(fairPrice.liveState.remainingFraction * 100).toFixed(0)}% of pre-match (` +
      `${fairPrice.preMatchLambdaHome.toFixed(2)}/${fairPrice.preMatchLambdaAway.toFixed(2)}).`
    : ' Pre-match (not yet kicked off).';

  const modelSummary =
    `Model: λ(${homeTeamName})=${fairPrice.lambdaHome.toFixed(2)} goals ` +
    `[${fairPrice.homeForm.isFallback ? 'league avg fallback' : `${fairPrice.homeForm.matchesSampled} recent matches`}], ` +
    `λ(${awayTeamName})=${fairPrice.lambdaAway.toFixed(2)} goals ` +
    `[${fairPrice.awayForm.isFallback ? 'league avg fallback' : `${fairPrice.awayForm.matchesSampled} recent matches`}].` +
    liveNote;

  return {
    fixtureId: market.fixtureId,
    generatedAt: Date.now(),
    matchResult,
    overUnder,
    bestEdge,
    modelSummary,
  };
}
