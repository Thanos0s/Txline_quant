import 'dotenv/config';
import axios from 'axios';

const origin = 'https://txline-dev.txodds.com';
const token = process.env['TXLINE_API_TOKEN'] ?? '';
const fixtureId = process.argv[2] ?? '18213979'; // Norway vs England, finished

async function main() {
  const authRes = await axios.post<{ token: string }>(`${origin}/auth/guest/start`);
  const jwt = authRes.data.token;

  console.log('Fetching historical scores for fixture', fixtureId);
  try {
    const res = await axios.get(`${origin}/api/scores/historical/${fixtureId}`, {
      headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': token },
    });
    const data = res.data as any[];
    console.log('count:', data.length);
    console.log(JSON.stringify(data.slice(0, 3), null, 2));
    console.log('...');
    console.log(JSON.stringify(data.slice(-3), null, 2));
  } catch (e: any) {
    console.log('historical error:', e.response?.status, JSON.stringify(e.response?.data));
  }

  console.log('\nFetching snapshot scores for fixture', fixtureId);
  try {
    const res2 = await axios.get(`${origin}/api/scores/snapshot/${fixtureId}`, {
      headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': token },
    });
    console.log('count:', res2.data.length);
    console.log(JSON.stringify(res2.data.slice(0, 5), null, 2));
  } catch (e: any) {
    console.log('snapshot error:', e.response?.status, JSON.stringify(e.response?.data));
  }
}

main().catch((e) => console.error('FATAL:', e instanceof Error ? e.message : e));
