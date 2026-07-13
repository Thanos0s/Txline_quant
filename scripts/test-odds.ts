import 'dotenv/config';
import axios from 'axios';

const origin = process.env['TXLINE_API_ORIGIN'] ?? 'https://txline-dev.txodds.com';
const token  = process.env['TXLINE_API_TOKEN']  ?? '';

const authRes = await axios.post<{ token: string }>(`${origin}/auth/guest/start`);
const jwt = authRes.data.token;

// Use a real World Cup fixture ID we saw earlier
const fixtureId = process.argv[2] ?? '17588223';

const res = await axios.get(`${origin}/api/odds/snapshot/${fixtureId}`, {
  headers: { Authorization: `Bearer ${jwt}`, 'X-Api-Token': token },
});

const odds: unknown[] = Array.isArray(res.data) ? res.data : [];
console.log(`Total odds rows for fixture ${fixtureId}: ${odds.length}`);
console.log(JSON.stringify(odds.slice(0, 5), null, 2));
