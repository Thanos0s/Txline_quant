import 'dotenv/config';
import { computeFairPrice } from '../src/lib/quant/fair-price';
import { fetchMarketOdds } from '../src/lib/quant/market-odds';
import { detectEdge } from '../src/lib/quant/edge';

const FIXTURE_ID = Number(process.argv[2] ?? 18237038);
const COMPETITION_ID = 72;

async function main() {
  // Re-derive real participant IDs directly from the fixtures endpoint to avoid guessing
  const { fetchFixturesSnapshot } = await import('../src/lib/ingestion/fixtures');
  const today = Math.floor(Date.now() / 86400000);
  const fixtures = await fetchFixturesSnapshot({ competitionId: COMPETITION_ID, startEpochDay: today - 2 });
  const fixture = fixtures.find((f: any) => f.FixtureId === FIXTURE_ID);

  if (!fixture) {
    console.error('Fixture not found in current window — pick a different one from /fixtures/snapshot');
    return;
  }

  const home = fixture.Participant1IsHome
    ? { id: fixture.Participant1Id, name: fixture.Participant1 }
    : { id: fixture.Participant2Id, name: fixture.Participant2 };
  const away = fixture.Participant1IsHome
    ? { id: fixture.Participant2Id, name: fixture.Participant2 }
    : { id: fixture.Participant1Id, name: fixture.Participant1 };

  console.log('Fixture:', home.name, 'vs', away.name, '| kickoff:', new Date(fixture.StartTime).toISOString());

  console.log('\n-- Computing fair price model --');
  const fairPrice = await computeFairPrice(
    home.id, home.name, away.id, away.name,
    COMPETITION_ID, FIXTURE_ID, fixture.StartTime, fixture.Participant1IsHome
  );
  console.log('Home form:', fairPrice.homeForm);
  console.log('Away form:', fairPrice.awayForm);
  console.log('Live state:', fairPrice.liveState);
  console.log('Pre-match lambda home:', fairPrice.preMatchLambdaHome.toFixed(3), '| away:', fairPrice.preMatchLambdaAway.toFixed(3));
  console.log('Remaining-time lambda home:', fairPrice.lambdaHome.toFixed(3), '| away:', fairPrice.lambdaAway.toFixed(3));
  console.log('Outcome probabilities:', fairPrice.outcomeProbabilities);
  console.log('Fair odds:', fairPrice.fairOdds);
  console.log('Over/Under', fairPrice.overUnder.line, ':', fairPrice.overUnder);

  console.log('\n-- Fetching live market odds --');
  const market = await fetchMarketOdds(FIXTURE_ID);
  console.log('Market:', JSON.stringify(market, null, 2));

  console.log('\n-- Edge report --');
  const report = detectEdge(fairPrice, market, home.name, away.name);
  console.log(report.modelSummary);
  for (const oe of [...report.matchResult, ...report.overUnder]) {
    console.log(' -', oe.rationale);
  }
  console.log('\nBest edge:', report.bestEdge?.rationale ?? 'none');
}

main().catch(e => console.error('FATAL:', e instanceof Error ? e.stack : e));
