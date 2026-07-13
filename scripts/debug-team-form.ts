import 'dotenv/config';
import { fetchFixturesSnapshot } from '../src/lib/ingestion/fixtures';
import { fetchScoresSnapshot } from '../src/lib/ingestion/scores';

const COMPETITION_ID = 72;
const TEAM_ID = 1999; // France, from previous run

async function main() {
  const today = Math.floor(Date.now() / 86400000);
  const fixtures = await fetchFixturesSnapshot({ competitionId: COMPETITION_ID, startEpochDay: today - 120 });

  const now = Date.now();
  const pastMatches = fixtures
    .filter((f: any) => (f.Participant1Id === TEAM_ID || f.Participant2Id === TEAM_ID) && f.StartTime < now)
    .sort((a: any, b: any) => b.StartTime - a.StartTime)
    .slice(0, 5);

  console.log('Past matches found:', pastMatches.length);
  for (const m of pastMatches as any[]) {
    console.log('\n---', m.FixtureId, m.Participant1, 'vs', m.Participant2, new Date(m.StartTime).toISOString());
    const rows = await fetchScoresSnapshot(m.FixtureId) as any[];
    console.log('score rows:', rows.length);
    const withScore = rows.filter((r: any) => r.Score);
    console.log('rows with Score field:', withScore.length);
    if (withScore.length > 0) {
      const latest = withScore.reduce((a: any, b: any) => (b.Seq > a.Seq ? b : a));
      console.log('latest scored Seq:', latest.Seq, '| GameState:', latest.GameState);
      console.log('Score:', JSON.stringify(latest.Score));
    } else if (rows.length > 0) {
      console.log('sample row keys:', Object.keys(rows[0]));
    }
  }
}

main().catch(e => console.error('FATAL:', e instanceof Error ? e.stack : e));
