import 'dotenv/config';
import axios from 'axios';

const origin = 'https://txline-dev.txodds.com';
const token = process.env['TXLINE_API_TOKEN'] ?? '';
const fixtureId = process.argv[2] ?? '18218149'; // Spain vs Belgium, live

async function main() {
  const authRes = await axios.post<{ token: string }>(`${origin}/auth/guest/start`);
  const jwt = authRes.data.token;
  const headers = { Authorization: `Bearer ${jwt}`, 'X-Api-Token': token };

  console.log('== /odds/snapshot/' + fixtureId + ' ==');
  try {
    const r = await axios.get(`${origin}/api/odds/snapshot/${fixtureId}`, { headers });
    console.log('count:', r.data.length);
    console.log(JSON.stringify(r.data.slice(0, 3), null, 2));
  } catch (e: any) {
    console.log('error:', e.response?.status, JSON.stringify(e.response?.data));
  }

  console.log('\n== /odds/updates/' + fixtureId + ' (live in-memory cache) ==');
  try {
    const r2 = await axios.get(`${origin}/api/odds/updates/${fixtureId}`, { headers });
    console.log('count:', r2.data.length);
    console.log(JSON.stringify(r2.data.slice(0, 5), null, 2));
  } catch (e: any) {
    console.log('error:', e.response?.status, JSON.stringify(e.response?.data));
  }
}

main().catch(e => console.error('FATAL:', e instanceof Error ? e.message : e));
