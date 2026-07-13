/**
 * Derives a team's recent scoring/conceding rate from real TxLINE data —
 * fixtures snapshot (to find that team's past matches) + scores snapshot
 * (to read the final goal tally of each one).
 *
 * This feeds the Poisson fair-price model. If a team has no resolvable
 * recent history (new team ID, or not enough finished fixtures yet), we
 * fall back to a configurable league-average rate so the model still
 * produces a usable (if less confident) output.
 */

import { fetchFixturesSnapshot, type Fixture } from '../ingestion/fixtures';
import { fetchScoresSnapshot } from '../ingestion/scores';

/** Default league-average expected goals per team per match (international soccer). */
export const LEAGUE_AVG_GOALS = 1.35;

/** How many of a team's most recent finished matches to sample. */
const FORM_SAMPLE_SIZE = 6;

/** How far back (days) to search for a team's past fixtures. */
const LOOKBACK_DAYS = 120;

export type TeamForm = {
  teamId: number;
  teamName: string;
  matchesSampled: number;
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  /** true if we fell back to league average due to insufficient data */
  isFallback: boolean;
};

type ScoreSnapshotRow = {
  Seq: number;
  Score?: {
    Participant1?: { Total?: { Goals?: number } };
    Participant2?: { Total?: { Goals?: number } };
  };
};

async function finalScoreOf(fixtureId: number): Promise<{ p1Goals: number; p2Goals: number } | null> {
  try {
    const rows = (await fetchScoresSnapshot(fixtureId)) as ScoreSnapshotRow[];
    if (!rows || rows.length === 0) return null;

    // Not every update carries a Score payload (many are clock/possession/card
    // events) — only consider rows that actually have one, then take the
    // latest such row (highest Seq) as the most recent known scoreline.
    const withScore = rows.filter(r => r.Score != null);
    if (withScore.length === 0) return null;

    const latest = withScore.reduce((a, b) => (b.Seq > a.Seq ? b : a));
    const p1 = latest.Score?.Participant1?.Total?.Goals ?? 0;
    const p2 = latest.Score?.Participant2?.Total?.Goals ?? 0;
    return { p1Goals: p1, p2Goals: p2 };
  } catch {
    return null;
  }
}

/**
 * Computes a team's recent-form goal rates by scanning the given competition's
 * fixture list for that team's past (already started) matches, then reading
 * each one's final score.
 */
export async function deriveTeamForm(
  teamId: number,
  teamName: string,
  competitionId: number,
  asOfMs: number = Date.now()
): Promise<TeamForm> {
  const today = Math.floor(asOfMs / 86_400_000);

  let fixtures: Fixture[] = [];
  try {
    fixtures = await fetchFixturesSnapshot({ competitionId, startEpochDay: today - LOOKBACK_DAYS });
  } catch {
    // fixtures fetch failed — fall back below
  }

  const pastMatches = fixtures
    .filter(f => (f.Participant1Id === teamId || f.Participant2Id === teamId) && f.StartTime < asOfMs)
    .sort((a, b) => b.StartTime - a.StartTime) // most recent first
    .slice(0, FORM_SAMPLE_SIZE);

  if (pastMatches.length === 0) {
    return {
      teamId,
      teamName,
      matchesSampled: 0,
      avgGoalsFor: LEAGUE_AVG_GOALS,
      avgGoalsAgainst: LEAGUE_AVG_GOALS,
      isFallback: true,
    };
  }

  let goalsFor = 0;
  let goalsAgainst = 0;
  let counted = 0;

  for (const match of pastMatches) {
    const score = await finalScoreOf(match.FixtureId);
    if (!score) continue;

    const isParticipant1 = match.Participant1Id === teamId;
    const forGoals = isParticipant1 ? score.p1Goals : score.p2Goals;
    const againstGoals = isParticipant1 ? score.p2Goals : score.p1Goals;

    goalsFor += forGoals;
    goalsAgainst += againstGoals;
    counted++;
  }

  if (counted === 0) {
    return {
      teamId,
      teamName,
      matchesSampled: 0,
      avgGoalsFor: LEAGUE_AVG_GOALS,
      avgGoalsAgainst: LEAGUE_AVG_GOALS,
      isFallback: true,
    };
  }

  return {
    teamId,
    teamName,
    matchesSampled: counted,
    avgGoalsFor: goalsFor / counted,
    avgGoalsAgainst: goalsAgainst / counted,
    isFallback: false,
  };
}

