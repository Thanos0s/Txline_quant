import 'dotenv/config';
import express, { Request, Response } from 'express';
import { z } from 'zod';
import {
  activateApiToken,
  requestGuestJwt,
  subscribeAndActivate,
  subscribeOnChain,
  verifyTradeOnChain,
} from './lib/txline';
import { getEnv, resolveNetworkDefaults } from './lib/config';
import { credentialStatus, ensureJwt } from './lib/api-client';
import { fetchFixturesSnapshot, fetchFixtureUpdates } from './lib/ingestion/fixtures';
import { fetchScoresSnapshot, fetchScoresLive, fetchScoresHistorical, fetchScoresInterval } from './lib/ingestion/scores';
import { fetchOddsSnapshot, fetchOddsLive, fetchOddsInterval } from './lib/ingestion/odds';
import { proxyStream } from './lib/ingestion/stream';
import { computeFairPrice } from './lib/quant/fair-price';
import { fetchMarketOdds } from './lib/quant/market-odds';
import { detectEdge } from './lib/quant/edge';
import { initDb, getPortfolio, getTrades, logTrade, resetPortfolio, getTradeById } from './lib/quant/db';
import { evaluateStrategy } from './lib/quant/strategy';
import { startBackgroundWorker } from './lib/quant/worker';

const app = express();
const port = 3001;

app.use(express.json());

// ── helpers ──────────────────────────────────────────────────────────────────

const subscribeInputSchema = z.object({
  serviceLevelId: z.number().int().positive().optional(),
  durationWeeks: z.number().int().positive().optional(),
  selectedLeagues: z.array(z.number().int().positive()).optional(),
});

const activateInputSchema = z.object({
  txSig: z.string().min(1),
  jwt: z.string().min(1),
  selectedLeagues: z.array(z.number().int().positive()).optional(),
});

function toMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function axiosDetail(error: unknown): string {
  // Surface TxLINE API error details when available
  if (
    error &&
    typeof error === 'object' &&
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'data' in error.response
  ) {
    const data = (error as any).response.data;
    const status = (error as any).response.status;
    return `HTTP ${status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  }
  return toMsg(error);
}

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((err) => {
      console.error('[api]', toMsg(err));
      res.status(500).json({ error: axiosDetail(err) });
    });
  };
}

// Auto-initialize JWT at startup (non-blocking)
ensureJwt().catch((e) => console.warn('[auth] Could not fetch initial JWT:', toMsg(e)));

// ── health ───────────────────────────────────────────────────────────────────

app.get('/api/health/credentials', (_req, res) => {
  res.json(credentialStatus());
});

app.get('/api/health', (_req, res) => {
  const env = getEnv();
  const defaults = resolveNetworkDefaults(env.SOLANA_NETWORK);
  res.json({
    status: 'ok',
    service: 'txline-quant-agent-api',
    timestamp: new Date().toISOString(),
    network: env.SOLANA_NETWORK,
    apiOrigin: env.TXLINE_API_ORIGIN ?? defaults.apiOrigin,
  });
});

// ── auth / subscription ───────────────────────────────────────────────────────

app.post('/api/txline/guest/start', wrap(async (_req, res) => {
  res.json(await requestGuestJwt());
}));

app.post('/api/txline/subscribe', wrap(async (req, res) => {
  const parsed = subscribeInputSchema.parse(req.body ?? {});
  res.json(await subscribeOnChain(parsed));
}));

app.post('/api/txline/activate', wrap(async (req, res) => {
  const parsed = activateInputSchema.parse(req.body ?? {});
  res.json(await activateApiToken(parsed));
}));

app.post('/api/txline/subscribe-activate', wrap(async (req, res) => {
  const parsed = subscribeInputSchema.parse(req.body ?? {});
  res.json(await subscribeAndActivate(parsed));
}));

// ── fixtures ──────────────────────────────────────────────────────────────────

app.get('/api/data/fixtures/snapshot', wrap(async (req, res) => {
  const competitionId = req.query['competitionId'] ? Number(req.query['competitionId']) : undefined;
  const startEpochDay = req.query['startEpochDay'] ? Number(req.query['startEpochDay']) : undefined;
  res.json(await fetchFixturesSnapshot({ competitionId, startEpochDay }));
}));

app.get('/api/data/fixtures/updates/:epochDay/:hourOfDay', wrap(async (req, res) => {
  const epochDay = Number(req.params['epochDay']);
  const hourOfDay = Number(req.params['hourOfDay']);
  res.json(await fetchFixtureUpdates(epochDay, hourOfDay));
}));

// ── scores ────────────────────────────────────────────────────────────────────

app.get('/api/data/scores/snapshot/:fixtureId', wrap(async (req, res) => {
  const fixtureId = Number(req.params['fixtureId']);
  const asOf = req.query['asOf'] ? Number(req.query['asOf']) : undefined;
  res.json(await fetchScoresSnapshot(fixtureId, asOf));
}));

app.get('/api/data/scores/live/:fixtureId', wrap(async (req, res) => {
  const fixtureId = Number(req.params['fixtureId']);
  res.json(await fetchScoresLive(fixtureId));
}));

app.get('/api/data/scores/historical/:fixtureId', wrap(async (req, res) => {
  const fixtureId = Number(req.params['fixtureId']);
  res.json(await fetchScoresHistorical(fixtureId));
}));

app.get('/api/data/scores/interval/:epochDay/:hourOfDay/:interval', wrap(async (req, res) => {
  const epochDay = Number(req.params['epochDay']);
  const hourOfDay = Number(req.params['hourOfDay']);
  const interval = Number(req.params['interval']);
  const fixtureId = req.query['fixtureId'] ? Number(req.query['fixtureId']) : undefined;
  res.json(await fetchScoresInterval(epochDay, hourOfDay, interval, fixtureId));
}));

app.get('/api/data/scores/stream', (req, res) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined;
  proxyStream('scores', res, lastEventId).catch(console.error);
});

// ── odds ──────────────────────────────────────────────────────────────────────

app.get('/api/data/odds/snapshot/:fixtureId', wrap(async (req, res) => {
  const fixtureId = Number(req.params['fixtureId']);
  const asOf = req.query['asOf'] ? Number(req.query['asOf']) : undefined;
  res.json(await fetchOddsSnapshot(fixtureId, asOf));
}));

app.get('/api/data/odds/live/:fixtureId', wrap(async (req, res) => {
  const fixtureId = Number(req.params['fixtureId']);
  res.json(await fetchOddsLive(fixtureId));
}));

app.get('/api/data/odds/interval/:epochDay/:hourOfDay/:interval', wrap(async (req, res) => {
  const epochDay = Number(req.params['epochDay']);
  const hourOfDay = Number(req.params['hourOfDay']);
  const interval = Number(req.params['interval']);
  res.json(await fetchOddsInterval(epochDay, hourOfDay, interval));
}));

app.get('/api/data/odds/stream', (req, res) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined;
  proxyStream('odds', res, lastEventId).catch(console.error);
});

// ── quant: fair price + edge detection ───────────────────────────────────────────────────

const edgeQuerySchema = z.object({
  competitionId: z.coerce.number().int().positive(),
  homeId: z.coerce.number().int().positive(),
  homeName: z.string().min(1),
  awayId: z.coerce.number().int().positive(),
  awayName: z.string().min(1),
  kickoffMs: z.coerce.number().int().positive(),
  participant1IsHome: z.coerce.boolean(),
  line: z.coerce.number().positive().optional(),
});

app.get('/api/quant/fair-price/:fixtureId', wrap(async (req, res) => {
  const fixtureId = Number(req.params['fixtureId']);
  const parsed = edgeQuerySchema.parse(req.query);
  const fairPrice = await computeFairPrice(
    parsed.homeId, parsed.homeName,
    parsed.awayId, parsed.awayName,
    parsed.competitionId,
    fixtureId,
    parsed.kickoffMs,
    parsed.participant1IsHome,
    parsed.line ?? 2.5
  );
  res.json(fairPrice);
}));

app.get('/api/quant/edge/:fixtureId', wrap(async (req, res) => {
  const fixtureId = Number(req.params['fixtureId']);
  const parsed = edgeQuerySchema.parse(req.query);

  const [fairPrice, market] = await Promise.all([
    computeFairPrice(
      parsed.homeId, parsed.homeName,
      parsed.awayId, parsed.awayName,
      parsed.competitionId,
      fixtureId,
      parsed.kickoffMs,
      parsed.participant1IsHome,
      parsed.line ?? 2.5
    ),
    fetchMarketOdds(fixtureId),
  ]);

  const edgeReport = detectEdge(fairPrice, market, parsed.homeName, parsed.awayName);

  res.json({ fairPrice, market, edgeReport });
}));

// ── quant agent endpoints ────────────────────────────────────────────────────

app.get('/api/quant/portfolio', (_req, res) => {
  res.json(getPortfolio());
});

app.get('/api/quant/trades', (_req, res) => {
  res.json(getTrades());
});

app.post('/api/quant/reset', (_req, res) => {
  resetPortfolio();
  res.json({ success: true, portfolio: getPortfolio() });
});

const executeTradeSchema = z.object({
  fixtureId: z.number().int().positive(),
  homeId: z.number().int().positive(),
  homeTeamName: z.string().min(1),
  awayId: z.number().int().positive(),
  awayTeamName: z.string().min(1),
  competitionId: z.number().int().positive(),
  kickoffMs: z.number().int().positive(),
  participant1IsHome: z.boolean(),
  line: z.number().positive().optional(),
});

app.post('/api/quant/trade', wrap(async (req, res) => {
  const parsed = executeTradeSchema.parse(req.body);
  
  const [fairPrice, market] = await Promise.all([
    computeFairPrice(
      parsed.homeId,
      parsed.homeTeamName,
      parsed.awayId,
      parsed.awayTeamName,
      parsed.competitionId,
      parsed.fixtureId,
      parsed.kickoffMs,
      parsed.participant1IsHome,
      parsed.line ?? 2.5
    ),
    fetchMarketOdds(parsed.fixtureId),
  ]);

  const portfolio = getPortfolio();
  const existing = getTrades();

  const decision = evaluateStrategy(
    fairPrice,
    market,
    parsed.homeTeamName,
    parsed.awayTeamName,
    portfolio.bankroll,
    existing
  );

  let loggedTrade = null;
  if (decision.shouldTrade && decision.outcome && decision.stake > 0) {
    loggedTrade = logTrade({
      fixtureId: parsed.fixtureId,
      homeTeam: parsed.homeTeamName,
      awayTeam: parsed.awayTeamName,
      outcome: decision.outcome,
      fairOdds: decision.fairOdds,
      marketOdds: decision.marketOdds,
      edgePercent: decision.edgePercent,
      stake: decision.stake,
      timestamp: Date.now(),
    });
  }

  res.json({
    decision,
    loggedTrade,
    portfolio: getPortfolio(),
  });
}));

app.post('/api/quant/verify/:tradeId', wrap(async (req, res) => {
  const tradeId = Number(req.params.tradeId);
  const trade = getTradeById(tradeId);
  if (!trade) {
    res.status(404).json({ error: `Trade #${tradeId} not found` });
    return;
  }

  if (trade.status !== 'SETTLED' || trade.seq == null) {
    res.status(400).json({ error: 'Trade must be settled and have a valid sequence number to verify on-chain.' });
    return;
  }

  const today = Math.floor(Date.now() / 86_400_000);
  const fixtures = await fetchFixturesSnapshot({ startEpochDay: today - 90 });
  const fixture = fixtures.find(f => f.FixtureId === trade.fixtureId);
  if (!fixture) {
    res.status(400).json({ error: 'Fixture metadata not found to resolve participant roles.' });
    return;
  }

  const participant1IsHome = fixture.Participant1IsHome;
  const homeTeamName = participant1IsHome ? fixture.Participant1 : fixture.Participant2;
  const isHomeWin = trade.outcome === `${homeTeamName} win`;

  const isValid = await verifyTradeOnChain(
    trade.fixtureId,
    trade.seq,
    trade.outcome,
    participant1IsHome,
    isHomeWin
  );

  res.json({
    tradeId,
    fixtureId: trade.fixtureId,
    outcome: trade.outcome,
    seq: trade.seq,
    verifiedOnChain: isValid,
  });
}));

// ── start ────────────────────────────────────────────────────────────────────────────────────

initDb();
startBackgroundWorker(30000); // Poll every 30s

// Serve frontend static assets in production
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, '../dist');

app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    next();
  } else {
    res.sendFile(path.join(distPath, 'index.html'));
  }
});

const serverPort = process.env.PORT ? Number(process.env.PORT) : port;
app.listen(serverPort, '0.0.0.0', () => {
  console.log(`API server listening on http://0.0.0.0:${serverPort}`);
});
