/**
 * Derives a fixture's current in-play state (score + elapsed playing time)
 * from the scores snapshot, so the fair-price model can be adjusted for
 * matches that have already started — instead of naively comparing a
 * pre-match-only model against a live in-play market price (which produces
 * meaningless "edges" once the actual score diverges from a 0-0 prior).
 */

import { fetchScoresSnapshot } from '../ingestion/scores';

/** Standard regulation match length. Extra time/stoppage is not modelled — noted as a known simplification. */
const MATCH_DURATION_SECONDS = 90 * 60;

export type LiveMatchState = {
  isLive: boolean;
  currentHomeGoals: number;
  currentAwayGoals: number;
  elapsedSeconds: number;
  /** Fraction of the match still to be played, 0..1. Used to scale down pre-match expected goals. */
  remainingFraction: number;
  /** Where the elapsed-time estimate came from. */
  clockSource: 'score-clock' | 'wall-clock-estimate' | 'not-started';
};

type ScoreSnapshotRow = {
  Seq: number;
  Score?: {
    Participant1?: { Total?: { Goals?: number } };
    Participant2?: { Total?: { Goals?: number } };
  };
  Clock?: { Running: boolean; Seconds: number };
};

export async function deriveLiveState(
  fixtureId: number,
  participant1IsHome: boolean,
  kickoffMs: number,
  asOfMs = Date.now()
): Promise<LiveMatchState> {
  const now = asOfMs;

  if (kickoffMs > now) {
    return {
      isLive: false,
      currentHomeGoals: 0,
      currentAwayGoals: 0,
      elapsedSeconds: 0,
      remainingFraction: 1,
      clockSource: 'not-started',
    };
  }

  let rows: ScoreSnapshotRow[] = [];
  try {
    rows = (await fetchScoresSnapshot(fixtureId)) as ScoreSnapshotRow[];
  } catch {
    // fall through with empty rows — we'll use the wall-clock estimate below
  }

  const withScore = rows.filter(r => r.Score != null);
  let currentHomeGoals = 0;
  let currentAwayGoals = 0;
  if (withScore.length > 0) {
    const latest = withScore.reduce((a, b) => (b.Seq > a.Seq ? b : a));
    const p1 = latest.Score?.Participant1?.Total?.Goals ?? 0;
    const p2 = latest.Score?.Participant2?.Total?.Goals ?? 0;
    currentHomeGoals = participant1IsHome ? p1 : p2;
    currentAwayGoals = participant1IsHome ? p2 : p1;
  }

  // Not every row carries a meaningful clock (many are 0/paused for
  // non-clock event types) — take the latest row with a genuinely elapsed
  // clock value.
  const withClock = rows.filter(r => r.Clock && r.Clock.Seconds > 0);
  let elapsedSeconds: number;
  let clockSource: LiveMatchState['clockSource'];

  if (withClock.length > 0) {
    const latestClock = withClock.reduce((a, b) => (b.Seq > a.Seq ? b : a));
    elapsedSeconds = latestClock.Clock!.Seconds;
    clockSource = 'score-clock';
  } else {
    // Fallback: estimate from wall-clock time since kickoff. Always available.
    elapsedSeconds = Math.floor((now - kickoffMs) / 1000);
    clockSource = 'wall-clock-estimate';
  }

  const remainingFraction = Math.max(0, Math.min(1, (MATCH_DURATION_SECONDS - elapsedSeconds) / MATCH_DURATION_SECONDS));

  return {
    isLive: true,
    currentHomeGoals,
    currentAwayGoals,
    elapsedSeconds,
    remainingFraction,
    clockSource,
  };
}
