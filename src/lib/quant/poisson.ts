/**
 * Pure Poisson-distribution math for football (soccer) goal modelling.
 *
 * This is the independent-Poisson ("Maher 1982") approach: goals scored by
 * each side are modelled as two independent Poisson processes with rates
 * (expected goals) lambdaHome and lambdaAway. It intentionally does NOT
 * apply the Dixon-Coles low-score correlation adjustment — that's a
 * reasonable v2 improvement, but the plain independent model is fully
 * transparent, deterministic, and easy for a reviewer to audit line by line.
 *
 * No external dependencies — this is ~80 lines of arithmetic.
 */

const MAX_GOALS = 10; // truncate the infinite Poisson sum; P(>10 goals) is negligible

const factorialCache: number[] = [1];
function factorial(n: number): number {
  for (let i = factorialCache.length; i <= n; i++) {
    factorialCache[i] = factorialCache[i - 1] * i;
  }
  return factorialCache[n];
}

/** P(X = k) for a Poisson random variable with rate lambda. */
export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/** 
 * Dixon-Coles parameter to adjust low-score correlation (0-0, 1-0, 0-1, 1-1).
 * Typically -0.12 for international soccer matches.
 */
const RHO = -0.12;

function dixonColesAdjustment(x: number, y: number, lambdaHome: number, lambdaAway: number): number {
  if (x === 0 && y === 0) return Math.max(0, 1 - lambdaHome * lambdaAway * RHO);
  if (x === 1 && y === 0) return Math.max(0, 1 + lambdaAway * RHO);
  if (x === 0 && y === 1) return Math.max(0, 1 + lambdaHome * RHO);
  if (x === 1 && y === 1) return Math.max(0, 1 - RHO);
  return 1;
}

export type MatchOutcomeProbabilities = {
  homeWin: number;
  draw: number;
  awayWin: number;
};

/**
 * P(home win), P(draw), P(away win) for two Poisson-distributed scorelines
 * with Dixon-Coles adjustment for low-scoring matches.
 *
 * `scoreOffset` supports in-play adjustment: pass
 * (currentHomeGoals - currentAwayGoals) and lambdaHome/lambdaAway as the
 * REMAINING-time expected goals, and this correctly computes the final
 * outcome probabilities as if simulating only the rest of the match on top
 * of the goals already on the board. Defaults to 0 for a pre-match (not
 * yet started) computation.
 */
export function matchOutcomeProbabilities(
  lambdaHome: number,
  lambdaAway: number,
  scoreOffset = 0
): MatchOutcomeProbabilities {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    const pHome = poissonPmf(h, lambdaHome);
    for (let a = 0; a <= MAX_GOALS; a++) {
      const pJointRaw = pHome * poissonPmf(a, lambdaAway);
      const adjustment = dixonColesAdjustment(h, a, lambdaHome, lambdaAway);
      const pJoint = pJointRaw * adjustment;
      
      const diff = h - a + scoreOffset;
      if (diff > 0) homeWin += pJoint;
      else if (diff === 0) draw += pJoint;
      else awayWin += pJoint;
    }
  }

  // Normalize away the (tiny) truncation error so probabilities sum to 1.
  const total = homeWin + draw + awayWin;
  return { homeWin: homeWin / total, draw: draw / total, awayWin: awayWin / total };
}

/**
 * P(total goals > line) and P(total goals < line) for a given handicap-style
 * line (supports whole, half, and quarter lines — e.g. 2.25, 2.5, 2.75).
 * P(exactly line) is only non-zero for integer lines ("push").
 *
 * `existingGoals` supports in-play adjustment: pass goals already scored
 * by both sides combined, and lambdaHome/lambdaAway as REMAINING-time
 * expected goals. Defaults to 0 for a pre-match computation.
 */
export function overUnderProbabilities(
  lambdaHome: number,
  lambdaAway: number,
  line: number,
  existingGoals = 0
): { over: number; under: number; push: number } {
  let over = 0;
  let under = 0;
  let push = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    const pHome = poissonPmf(h, lambdaHome);
    for (let a = 0; a <= MAX_GOALS; a++) {
      const pJoint = pHome * poissonPmf(a, lambdaAway);
      const total = h + a + existingGoals;
      if (total > line) over += pJoint;
      else if (total < line) under += pJoint;
      else push += pJoint;
    }
  }

  const norm = over + under + push;
  return { over: over / norm, under: under / norm, push: push / norm };
}

/** Convert a probability to fair (no-margin) decimal odds. */
export function probabilityToOdds(probability: number): number {
  if (probability <= 0) return Infinity;
  return 1 / probability;
}

/** Convert decimal odds to implied probability. */
export function oddsToProbability(decimalOdds: number): number {
  if (decimalOdds <= 0) return 0;
  return 1 / decimalOdds;
}
