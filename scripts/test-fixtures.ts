import 'dotenv/config';
import axios from 'axios';

const origin = process.env['TXLINE_API_ORIGIN'] ?? 'https://txline-dev.txodds.com';
const token  = process.env['TXLINE_API_TOKEN']  ?? '';

const authRes = await axios.post<{ token: string }>(`${origin}/auth/guest/start`);
const jwt = authRes.data.token;

const today = Math.floor(Date.now() / 86400000);

const res = await axios.get(`${origin}/api/fixtures/snapshot?startEpochDay=${today - 30}`, {
  headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': token },
});

const fixtures: unknown[] = Array.isArray(res.data) ? res.data : [];
console.log(`Total fixtures: ${fixtures.length}`);
if (fixtures.length > 0) {
  console.log('\nFirst fixture (all fields):');
  console.log(JSON.stringify(fixtures[0], null, 2));
  console.log('\nSecond fixture (all fields):');
  console.log(JSON.stringify(fixtures[1] ?? 'N/A', null, 2));
}
