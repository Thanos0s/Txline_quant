import 'dotenv/config';
import axios from 'axios';

const origin = process.env['TXLINE_API_ORIGIN'] ?? 'https://txline-dev.txodds.com';
const token  = process.env['TXLINE_API_TOKEN']  ?? '';

console.log('origin:', origin);
console.log('token set:', !!token, '| value:', token.slice(0, 30));

// Step 1: get a fresh JWT
console.log('\n-- Step 1: fetch guest JWT --');
const authRes = await axios.post<{ token: string }>(`${origin}/auth/guest/start`);
const jwt = authRes.data.token;
console.log('JWT ok, prefix:', jwt.slice(0, 40));

// Step 2: hit the stream
console.log('\n-- Step 2: connect to scores/stream --');
try {
  const r = await axios.get(`${origin}/api/scores/stream`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      'X-Api-Token': token,
      Accept: 'text/event-stream',
      'Accept-Encoding': 'identity',
    },
    responseType: 'stream',
    timeout: 10000,
  });

  console.log('HTTP status:', r.status);
  console.log('Content-Type:', r.headers['content-type']);

  let buf = '';
  await new Promise<void>((resolve) => {
    r.data.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      console.log('chunk received, total bytes so far:', buf.length);
      if (buf.length > 500) {
        (r.data as any).destroy();
        resolve();
      }
    });
    r.data.on('close', () => resolve());
    r.data.on('error', (e: Error) => { console.log('stream error:', e.message); resolve(); });
    setTimeout(() => { console.log('timeout — no data in 10s'); (r.data as any).destroy(); resolve(); }, 10000);
  });

  console.log('\nSAMPLE OUTPUT:\n', buf.slice(0, 500));
} catch (e) {
  if (axios.isAxiosError(e)) {
    console.log('Axios error code:', e.code);
    console.log('HTTP status:', e.response?.status);
    if (e.response?.status) {
      // Don't stringify stream data - it's circular
      console.log('Response headers:', JSON.stringify(e.response.headers));
    }
  } else {
    console.log('Error:', e instanceof Error ? e.message : String(e));
  }
}
