import { getPendingTrades, settleTrade, type Trade } from './db';
import { fetchScoresSnapshot } from '../ingestion/scores';
import { fetchFixturesSnapshot } from '../ingestion/fixtures';

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

type ScoreUpdateRow = {
  Seq: number;
  Period?: number;
  Phase?: number;
  Status?: string;
  Score?: {
    Participant1?: { Total?: { Goals?: number } };
    Participant2?: { Total?: { Goals?: number } };
  };
  Clock?: { Running: boolean; Seconds: number };
};

/**
 * Resolves whether a match is finished and returns the final goals of home/away teams.
 */
async function checkMatchSettlement(trade: Trade): Promise<{ isFinished: boolean; homeGoals?: number; awayGoals?: number; seq?: number }> {
  try {
    const scores = (await fetchScoresSnapshot(trade.fixtureId)) as ScoreUpdateRow[];
    if (!scores || scores.length === 0) {
      return { isFinished: false };
    }

    const latestRow = scores.reduce((a, b) => (b.Seq > a.Seq ? b : a));

    // Check if the game has finished
        const withClock = scores.filter(s => s.Clock != null);
    const latestClock = withClock.reduce((a, b) => (!a || b.Seq > a.Seq ? b : a), null as ScoreUpdateRow | null);
    const clockFinished = latestClock && !latestClock.Clock!.Running && latestClock.Clock!.Seconds >= 90 * 60;

    // Check Game Phase / Period codes (5 = Ended/Finished, 10 = Ended after Extra Time, 13 = Ended after Pen Shootout)
    const phaseFinished = scores.some(s => 
      [5, 10, 13].includes(s.Period as number) ||
      [5, 10, 13].includes(s.Phase as number) ||
      s.Status === 'Finished' || s.Status === 'F'
    );

    // Also check time elapsed as safety fallback (if we have score rows and it's > 3 hours since match start)
    const timeFinished = Date.now() - trade.timestamp > 3.5 * 3600 * 1000;

    const isFinished = !!(clockFinished || phaseFinished || timeFinished);
    if (!isFinished) {
      return { isFinished: false };
    }

    // Get goals
    const withScore = scores.filter(s => s.Score != null);
    if (withScore.length === 0) {
      return { isFinished: true, homeGoals: 0, awayGoals: 0, seq: latestRow.Seq }; // Assume 0-0 if finished without score rows
    }

    const latestScore = withScore.reduce((a, b) => (b.Seq > a.Seq ? b : a));
    const p1 = latestScore.Score?.Participant1?.Total?.Goals ?? 0;
    const p2 = latestScore.Score?.Participant2?.Total?.Goals ?? 0;

    // Resolve Home vs Away from Fixtures API
    const today = Math.floor(Date.now() / 86_400_000);
    const fixtures = await fetchFixturesSnapshot({ startEpochDay: today - 30 });
    const matchFixture = fixtures.find(f => f.FixtureId === trade.fixtureId);

    let homeGoals = p1;
    let awayGoals = p2;

    if (matchFixture) {
      homeGoals = matchFixture.Participant1IsHome ? p1 : p2;
      awayGoals = matchFixture.Participant1IsHome ? p2 : p1;
    }

    return {
      isFinished: true,
      homeGoals,
      awayGoals,
      seq: latestScore.Seq,
    };
  } catch (err) {
    console.error(`[worker] Error checking settlement for fixture ${trade.fixtureId}:`, err);
    return { isFinished: false };
  }
}

export async function processPendingTrades() {
  const pending = getPendingTrades();
  if (pending.length === 0) return;

  console.log(`[worker] Checking ${pending.length} pending trade(s)...`);

  for (const trade of pending) {
    const { isFinished, homeGoals, awayGoals, seq } = await checkMatchSettlement(trade);

    if (isFinished && homeGoals !== undefined && awayGoals !== undefined) {
      let result: 'WON' | 'LOST' | 'VOID' = 'LOST';

      const totalGoals = homeGoals + awayGoals;

      if (trade.outcome === `${trade.homeTeam} win`) {
        result = homeGoals > awayGoals ? 'WON' : 'LOST';
      } else if (trade.outcome === `${trade.awayTeam} win`) {
        result = awayGoals > homeGoals ? 'WON' : 'LOST';
      } else if (trade.outcome === 'Draw') {
        result = homeGoals === awayGoals ? 'WON' : 'LOST';
      } else if (trade.outcome.startsWith('Over ')) {
        const line = parseFloat(trade.outcome.split(' ')[1]);
        result = totalGoals > line ? 'WON' : 'LOST';
      } else if (trade.outcome.startsWith('Under ')) {
        const line = parseFloat(trade.outcome.split(' ')[1]);
        result = totalGoals < line ? 'WON' : 'LOST';
      }

      console.log(`[worker] Settling Trade #${trade.id} (${trade.homeTeam} vs ${trade.awayTeam}): outcome="${trade.outcome}" score=${homeGoals}-${awayGoals} -> ${result}`);
      settleTrade(trade.id, result, seq);
    }
  }
}

export function startBackgroundWorker(intervalMs = 30000) {
  if (isRunning) return;
  isRunning = true;

  console.log(`[worker] Background settlement worker started (polling every ${intervalMs / 1000}s).`);
  
  // Run once immediately
  processPendingTrades().catch(console.error);

  intervalId = setInterval(() => {
    processPendingTrades().catch(console.error);
  }, intervalMs);
}

export function stopBackgroundWorker() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  isRunning = false;
  console.log('[worker] Background settlement worker stopped.');
}
