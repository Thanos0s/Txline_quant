/**
 * Combines two teams' recent-form goal rates into Poisson expected-goals
 * (lambda) values, then derives fair (no-margin) match odds from them.
 *
 * This is the model that gets compared against TxLINE's de-margined
 * StablePrice in edge.ts — it is our independent estimate of "true" odds.
 *
 * If the fixture has already kicked off, the model is adjusted for the
 * current in-play state (see live-state.ts): pre-match expected goals are
 * scaled down by the fraction of the match remaining, and outcome
 * probabilities are computed on top of the goals already scored. Without
 * this, comparing a "pre-match-only" fair price against a live in-play
 * market price produces meaningless results once the actual score diverges
 * from a blank 0-0 prior.
 */

import {
  matchOutcomeProbabilities,
  overUnderProbabilities,
  probabilityToOdds,
  type MatchOutcomeProbabilities,
} from './poisson';
import { deriveTeamForm, LEAGUE_AVG_GOALS, type TeamForm } from './team-form';
import { deriveLiveState, type LiveMatchState } from './live-state';

/** Home teams score slightly more than average — standard home-advantage multiplier. */
const HOME_ADVANTAGE = 1.1;

/**
 * Shrinkage constant (in "matches") for blending a team's small observed
 * sample toward the league average. With only a handful of matches, one
 * fluky low-scoring game can swing the raw average hard; this is the
 * standard empirical-Bayes fix: weight = sampled / (sampled + K), so more
 * history → more trust in the observed rate, less history → fall back
 * toward the league average instead of overreacting to noise.
 */
const SHRINKAGE_K = 4;

function shrinkTowardLeagueAverage(observed: number, matchesSampled: number): number {
  const weight = matchesSampled / (matchesSampled + SHRINKAGE_K);
  return weight * observed + (1 - weight) * LEAGUE_AVG_GOALS;
}

export type FairPriceResult = {
  homeForm: TeamForm;
  awayForm: TeamForm;
  liveState: LiveMatchState;
  /** Pre-match (full 90 min) expected goals, before any in-play time-remaining scaling. */
  preMatchLambdaHome: number;
  preMatchLambdaAway: number;
  /** Expected goals for the rest of the match (equal to pre-match lambda if not started yet). */
  lambdaHome: number;
  lambdaAway: number;
  outcomeProbabilities: MatchOutcomeProbabilities;
  fairOdds: {
    home: number;
    draw: number;
    away: number;
  };
  overUnder: {
    line: number;
    overProbability: number;
    underProbability: number;
    fairOverOdds: number;
    fairUnderOdds: number;
  };
};

/**
 * lambdaHome = leagueAvg * (homeAttack / leagueAvg) * (awayDefense / leagueAvg) * homeAdvantage
 * lambdaAway = leagueAvg * (awayAttack / leagueAvg) * (homeDefense / leagueAvg)
 *
 * This is the standard Maher-style relative-strength formulation: each
 * team's attack/defense rating is expressed relative to the league average,
 * then multiplied together to get an expected-goals rate for the matchup.
 */
function computePreMatchLambdas(home: TeamForm, away: TeamForm): { lambdaHome: number; lambdaAway: number } {
  const homeGoalsFor     = shrinkTowardLeagueAverage(home.avgGoalsFor, home.matchesSampled);
  const homeGoalsAgainst = shrinkTowardLeagueAverage(home.avgGoalsAgainst, home.matchesSampled);
  const awayGoalsFor     = shrinkTowardLeagueAverage(away.avgGoalsFor, away.matchesSampled);
  const awayGoalsAgainst = shrinkTowardLeagueAverage(away.avgGoalsAgainst, away.matchesSampled);

  const homeAttack  = homeGoalsFor / LEAGUE_AVG_GOALS;
  const homeDefense = homeGoalsAgainst / LEAGUE_AVG_GOALS;
  const awayAttack  = awayGoalsFor / LEAGUE_AVG_GOALS;
  const awayDefense = awayGoalsAgainst / LEAGUE_AVG_GOALS;

  const lambdaHome = LEAGUE_AVG_GOALS * homeAttack * awayDefense * HOME_ADVANTAGE;
  const lambdaAway = LEAGUE_AVG_GOALS * awayAttack * homeDefense;

  return { lambdaHome, lambdaAway };
}

export async function computeFairPrice(
  homeTeamId: number,
  homeTeamName: string,
  awayTeamId: number,
  awayTeamName: string,
  competitionId: number,
  fixtureId: number,
  kickoffMs: number,
  participant1IsHome: boolean,
  overUnderLine = 2.5,
  asOfMs = Date.now()
): Promise<FairPriceResult> {
  const [homeForm, awayForm, liveState] = await Promise.all([
    deriveTeamForm(homeTeamId, homeTeamName, competitionId, asOfMs),
    deriveTeamForm(awayTeamId, awayTeamName, competitionId, asOfMs),
    deriveLiveState(fixtureId, participant1IsHome, kickoffMs, asOfMs),
  ]);

  const { lambdaHome: preMatchLambdaHome, lambdaAway: preMatchLambdaAway } = computePreMatchLambdas(homeForm, awayForm);

  // Scale expected goals down by the fraction of the match still to be
  // played. Pre-match (remainingFraction === 1), this is a no-op.
  const lambdaHome = preMatchLambdaHome * liveState.remainingFraction;
  const lambdaAway = preMatchLambdaAway * liveState.remainingFraction;

  const scoreOffset = liveState.currentHomeGoals - liveState.currentAwayGoals;
  const existingGoals = liveState.currentHomeGoals + liveState.currentAwayGoals;

  const outcomeProbabilities = matchOutcomeProbabilities(lambdaHome, lambdaAway, scoreOffset);
  const ou = overUnderProbabilities(lambdaHome, lambdaAway, overUnderLine, existingGoals);

  return {
    homeForm,
    awayForm,
    liveState,
    preMatchLambdaHome,
    preMatchLambdaAway,
    lambdaHome,
    lambdaAway,
    outcomeProbabilities,
    fairOdds: {
      home: probabilityToOdds(outcomeProbabilities.homeWin),
      draw: probabilityToOdds(outcomeProbabilities.draw),
      away: probabilityToOdds(outcomeProbabilities.awayWin),
    },
    overUnder: {
      line: overUnderLine,
      overProbability: ou.over,
      underProbability: ou.under,
      fairOverOdds: probabilityToOdds(ou.over),
      fairUnderOdds: probabilityToOdds(ou.under),
    },
  };
}
