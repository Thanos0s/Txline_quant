import 'dotenv/config';
import axios from 'axios';

const origin = 'https://txline-dev.txodds.com';
const token = process.env['TXLINE_API_TOKEN'] ?? '';

async function main() {
  const authRes = await axios.post<{ token: string }>(`${origin}/auth/guest/start`);
  const jwt = authRes.data.token;
  const today = Math.floor(Date.now() / 86400000);

  const res = await axios.get(`${origin}/api/fixtures/snapshot?competitionId=72&startEpochDay=${today - 2}`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': token },
  });

  const fixtures = res.data as any[];
  console.log('count:', fixtures.length);

  const now = Date.now();
  const upcoming = fixtures.filter((f) => f.StartTime > now).slice(0, 8);
  const past = fixtures.filter((f) => f.StartTime <= now).slice(-5);

  console.log('\nUPCOMING:');
  for (const f of upcoming) {
    console.log(f.FixtureId, new Date(f.StartTime).toISOString(), f.Participant1, 'vs', f.Participant2);
  }

  console.log('\nPAST:');
  for (const f of past) {
    console.log(f.FixtureId, new Date(f.StartTime).toISOString(), f.Participant1, 'vs', f.Participant2);
  }

  // Try odds on first upcoming fixture
  if (upcoming.length > 0) {
    const fid = upcoming[0].FixtureId;
    console.log('\nTrying odds snapshot for fixture', fid);
    try {
      const oddsRes = await axios.get(`${origin}/api/odds/snapshot/${fid}`, {
        headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': token },
      });
      console.log('odds count:', oddsRes.data.length);
      console.log(JSON.stringify(oddsRes.data.slice(0, 3), null, 2));
    } catch (e: any) {
      console.log('odds error:', e.response?.status, JSON.stringify(e.response?.data));
    }
  }
}

main().catch((e) => console.error('FATAL:', e instanceof Error ? e.message : e));
