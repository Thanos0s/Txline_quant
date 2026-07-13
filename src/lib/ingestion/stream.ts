import type { Response } from 'express';
import axios from 'axios';
import { getCredentials, ensureJwt, renewJwt } from '../api-client';

export type StreamTarget = 'odds' | 'scores';

function sseWrite(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function proxyStream(
  target: StreamTarget,
  res: Response,
  lastEventId?: string
): Promise<void> {
  // SSE headers — must be set before any await so the browser gets them immediately
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send an immediate ping so the browser EventSource fires onopen right away
  sseWrite(res, 'ping', { ts: Date.now(), target });

  // Ensure we have a JWT
  try {
    await ensureJwt();
  } catch (e) {
    sseWrite(res, 'error', { message: 'Could not fetch JWT: ' + (e instanceof Error ? e.message : String(e)) });
    res.end();
    return;
  }

  const { jwt, apiToken, apiOrigin } = getCredentials();

  if (!apiToken) {
    sseWrite(res, 'error', { message: 'TXLINE_API_TOKEN is not set. Add it to .env and restart the API server.' });
    res.end();
    return;
  }

  const url = `${apiOrigin}/api/${target}/stream`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    'X-Api-Token': apiToken,
    Accept: 'text/event-stream',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
  };
  if (lastEventId) headers['Last-Event-ID'] = lastEventId;

  // Local heartbeat timer — keeps the connection open when no live events come through
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      sseWrite(res, 'heartbeat', { ts: Date.now() });
    }
  }, 25_000);

  const cleanup = () => clearInterval(heartbeat);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const upstream = await axios.get<NodeJS.ReadableStream>(url, {
        headers,
        responseType: 'stream',
        timeout: 0,
      });

      sseWrite(res, 'connected', { target, status: upstream.status });

      const stream = upstream.data;

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          if (!res.writableEnded) res.write(chunk);
        });
        stream.on('end',   resolve);
        stream.on('error', reject);
        res.on('close', () => {
          (stream as import('node:stream').Readable).destroy();
          resolve();
        });
      });

      cleanup();
      if (!res.writableEnded) res.end();
      return;

    } catch (err: unknown) {
      if (!axios.isAxiosError(err)) {
        sseWrite(res, 'error', { message: err instanceof Error ? err.message : String(err) });
        break;
      }

      const status = err.response?.status;
      const code   = err.code ?? '';

      if ((status === 401 || status === 403) && attempt === 1) {
        try {
          const newJwt = await renewJwt();
          headers['Authorization'] = `Bearer ${newJwt}`;
          continue;
        } catch {
          sseWrite(res, 'error', { message: 'JWT renewal failed.' });
          break;
        }
      }

      if (!err.response && ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code) && attempt < 3) {
        sseWrite(res, 'reconnecting', { attempt, code });
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }

      sseWrite(res, 'error', {
        message: status
          ? `TxLINE returned HTTP ${status} — check your API token and subscription.`
          : `Network error (${code}): ${err.message}`,
      });
      break;
    }
  }

  cleanup();
  if (!res.writableEnded) res.end();
}
