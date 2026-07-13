import type { FairPriceResult } from './fair-price';
import type { MarketOdds } from './market-odds';
import { detectEdge, type OutcomeEdge, type EdgeReport } from './edge';
import type { Trade } from './db';

/** Kelly scaling multiplier (e.g. Quarter-Kelly for risk mitigation) */
const KELLY_FRACTION = 0.25;

/** Hard limit: never risk more than 5% of the total bankroll on a single bet */
const MAX_EXPOSURE_PER_TRADE = 0.05;

/** Minimum edge required to trigger a trade (sweep-optimised) */
const MIN_REQUIRED_EDGE = 10.0; // 10.0%

/** Hard stop: do not trade if less than 10% of the match is remaining (last 9 minutes) */
const MIN_REMAINING_FRACTION = 0.10;

/** Maximum market decimal odds we are willing to trade on (sweep-optimised: avoids long-shots) */
const MAX_TRADABLE_ODDS = 3.50;

/** Minimum historical matches required per team (sweep-optimised) */
const MIN_MATCHES_SAMPLED = 3;

export type StrategyDecision = {
  shouldTrade: boolean;
  outcome: string | null;
  fairOdds: number;
  marketOdds: number;
  edgePercent: number;
  stake: number;
  reason: string;
};

export function evaluateStrategy(
  fairPrice: FairPriceResult,
  market: MarketOdds,
  homeTeamName: string,
  awayTeamName: string,
  bankroll: number,
  existingTrades: Trade[]
): StrategyDecision {
  const edgeReport = detectEdge(fairPrice, market, homeTeamName, awayTeamName);
  
  if (!edgeReport.bestEdge) {
    return {
      shouldTrade: false,
      outcome: null,
      fairOdds: 0,
      marketOdds: 0,
      edgePercent: 0,
      stake: 0,
      reason: 'No market odds available to compare.',
    };
  }

  const best = edgeReport.bestEdge;

  // 1. Check for Duplicate Trades
  const isDuplicate = existingTrades.some(
    t => t.fixtureId === market.fixtureId && t.outcome === best.outcome && t.status === 'PENDING'
  );
  if (isDuplicate) {
    return {
      shouldTrade: false,
      outcome: best.outcome,
      fairOdds: best.fairOdds,
      marketOdds: best.marketOdds,
      edgePercent: best.edgePercent,
      stake: 0,
      reason: `Vetoed: Already have an active trade on "${best.outcome}" for fixture ${market.fixtureId}.`,
    };
  }

  // 2. Check Match Time Circuit Breaker (In-Play)
  // Only veto if the match is actively in-play (elapsed time <= 90 minutes) and late in the match.
  // For completed/stoppage matches (elapsed > 90 mins), we bypass this to allow historical/demo trade simulations.
  const isActivelyInPlay = fairPrice.liveState.isLive && fairPrice.liveState.elapsedSeconds <= 90 * 60;
  if (isActivelyInPlay && fairPrice.liveState.remainingFraction < MIN_REMAINING_FRACTION) {
    return {
      shouldTrade: false,
      outcome: best.outcome,
      fairOdds: best.fairOdds,
      marketOdds: best.marketOdds,
      edgePercent: best.edgePercent,
      stake: 0,
      reason: `Vetoed: Too late in the match to trade (${Math.round(fairPrice.liveState.elapsedSeconds / 60)}' elapsed).`,
    };
  }

  // 3. Check for Fallback Ratings (Insufficient Data)
  if (fairPrice.homeForm.isFallback || fairPrice.awayForm.isFallback) {
    return {
      shouldTrade: false,
      outcome: best.outcome,
      fairOdds: best.fairOdds,
      marketOdds: best.marketOdds,
      edgePercent: best.edgePercent,
      stake: 0,
      reason: 'Vetoed: One or both teams are using league-average fallback ratings due to insufficient historical match data.',
    };
  }

  // 4. Check Sample Size constraint
  if (fairPrice.homeForm.matchesSampled < MIN_MATCHES_SAMPLED || fairPrice.awayForm.matchesSampled < MIN_MATCHES_SAMPLED) {
    return {
      shouldTrade: false,
      outcome: best.outcome,
      fairOdds: best.fairOdds,
      marketOdds: best.marketOdds,
      edgePercent: best.edgePercent,
      stake: 0,
      reason: `Vetoed: Insufficient matches sampled (${fairPrice.homeForm.matchesSampled}/${fairPrice.awayForm.matchesSampled} matches, min ${MIN_MATCHES_SAMPLED}).`,
    };
  }

  // 5. Check Max Odds constraint (avoid long-shots)
  if (best.marketOdds > MAX_TRADABLE_ODDS) {
    return {
      shouldTrade: false,
      outcome: best.outcome,
      fairOdds: best.fairOdds,
      marketOdds: best.marketOdds,
      edgePercent: best.edgePercent,
      stake: 0,
      reason: `Vetoed: Market odds (${best.marketOdds.toFixed(2)}) exceed maximum tradable threshold of ${MAX_TRADABLE_ODDS.toFixed(2)}.`,
    };
  }

  // 6. Check Minimum Edge Threshold
  if (best.edgePercent < MIN_REQUIRED_EDGE) {
    return {
      shouldTrade: false,
      outcome: best.outcome,
      fairOdds: best.fairOdds,
      marketOdds: best.marketOdds,
      edgePercent: best.edgePercent,
      stake: 0,
      reason: `Vetoed: Best edge (${best.edgePercent.toFixed(1)}%) is below the minimum threshold of ${MIN_REQUIRED_EDGE}%.`,
    };
  }

  // 4. Calculate Kelly Sizing
  // formula: f* = (p * b - q) / b = (p * (b + 1) - 1) / b
  // where b = marketOdds - 1, p = fairProbability
  const p = best.fairProbability;
  const b = best.marketOdds - 1;
  
  if (p <= 0 || b <= 0) {
    return {
      shouldTrade: false,
      outcome: best.outcome,
      fairOdds: best.fairOdds,
      marketOdds: best.marketOdds,
      edgePercent: best.edgePercent,
      stake: 0,
      reason: 'Vetoed: Invalid odds or probabilities.',
    };
  }

  const rawKelly = (p * best.marketOdds - 1) / b;
  const targetFraction = rawKelly * KELLY_FRACTION;

  if (targetFraction <= 0) {
    return {
      shouldTrade: false,
      outcome: best.outcome,
      fairOdds: best.fairOdds,
      marketOdds: best.marketOdds,
      edgePercent: best.edgePercent,
      stake: 0,
      reason: `Vetoed: Adjusted Kelly fraction is non-positive (${(targetFraction * 100).toFixed(2)}%).`,
    };
  }

  // 5. Enforce Hard Limits
  const cappedFraction = Math.min(targetFraction, MAX_EXPOSURE_PER_TRADE);
  const stake = Math.round(bankroll * cappedFraction * 100) / 100; // Round to 2 decimals

  const isCapped = cappedFraction < targetFraction;
  const capNote = isCapped ? ' (Capped at 5% max exposure limit)' : '';

  return {
    shouldTrade: true,
    outcome: best.outcome,
    fairOdds: best.fairOdds,
    marketOdds: best.marketOdds,
    edgePercent: best.edgePercent,
    stake,
    reason: `Passed all checks. Suggested stake: $${stake} based on ${(targetFraction * 100).toFixed(1)}% Kelly${capNote}.`,
  };
}
