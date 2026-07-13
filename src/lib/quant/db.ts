import Database from 'better-sqlite3';
import { join } from 'path';

const DB_PATH = join(process.cwd(), 'quant_agent.db');
let db: Database.Database | null = null;

export type Trade = {
  id: number;
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  outcome: string;
  fairOdds: number;
  marketOdds: number;
  edgePercent: number;
  stake: number;
  status: 'PENDING' | 'SETTLED' | 'VOID';
  pnl: number;
  timestamp: number;
  seq?: number | null;
};

export type Portfolio = {
  bankroll: number;
  exposure: number;
};

export function initDb() {
  if (db) return;
  db = new Database(DB_PATH);

  // Enable WAL mode for performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bankroll REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fixtureId INTEGER NOT NULL,
      homeTeam TEXT NOT NULL,
      awayTeam TEXT NOT NULL,
      outcome TEXT NOT NULL,
      fairOdds REAL NOT NULL,
      marketOdds REAL NOT NULL,
      edgePercent REAL NOT NULL,
      stake REAL NOT NULL,
      status TEXT DEFAULT 'PENDING',
      pnl REAL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      seq INTEGER DEFAULT NULL
    );
  `);

  try {
    db.exec("ALTER TABLE trades ADD COLUMN seq INTEGER DEFAULT NULL");
  } catch (err) {
    // Ignore error if column already exists
  }

  // Initialize portfolio bankroll to $10,000 if empty
  const row = db.prepare('SELECT bankroll FROM portfolio LIMIT 1').get() as { bankroll: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO portfolio (bankroll) VALUES (?)').run(10000.0);
  }
}

function getDb(): Database.Database {
  if (!db) {
    initDb();
  }
  return db!;
}

export function getPortfolio(): Portfolio {
  const sqlite = getDb();
  const row = sqlite.prepare('SELECT bankroll FROM portfolio LIMIT 1').get() as { bankroll: number };
  const pendingRow = sqlite.prepare("SELECT SUM(stake) as exposure FROM trades WHERE status = 'PENDING'").get() as { exposure: number | null };

  return {
    bankroll: row?.bankroll ?? 10000.0,
    exposure: pendingRow?.exposure ?? 0.0,
  };
}

export function logTrade(trade: Omit<Trade, 'id' | 'status' | 'pnl'>): Trade {
  const sqlite = getDb();
  const stmt = sqlite.prepare(`
    INSERT INTO trades (fixtureId, homeTeam, awayTeam, outcome, fairOdds, marketOdds, edgePercent, stake, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    trade.fixtureId,
    trade.homeTeam,
    trade.awayTeam,
    trade.outcome,
    trade.fairOdds,
    trade.marketOdds,
    trade.edgePercent,
    trade.stake,
    trade.timestamp
  );

  return {
    id: Number(info.lastInsertRowid),
    ...trade,
    status: 'PENDING',
    pnl: 0,
  };
}

export function getTradeById(id: number): Trade | undefined {
  const sqlite = getDb();
  return sqlite.prepare('SELECT * FROM trades WHERE id = ?').get(id) as Trade | undefined;
}

export function getTrades(limit = 100): Trade[] {
  const sqlite = getDb();
  return sqlite.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit) as Trade[];
}

export function getPendingTrades(): Trade[] {
  const sqlite = getDb();
  return sqlite.prepare("SELECT * FROM trades WHERE status = 'PENDING'").all() as Trade[];
}

export function settleTrade(id: number, result: 'WON' | 'LOST' | 'VOID', seq?: number | null) {
  const sqlite = getDb();

  // Fetch the trade to compute pnl
  const trade = sqlite.prepare('SELECT * FROM trades WHERE id = ?').get(id) as Trade | undefined;
  if (!trade || trade.status !== 'PENDING') return;

  let pnl = 0;
  if (result === 'WON') {
    pnl = trade.stake * (trade.marketOdds - 1);
  } else if (result === 'LOST') {
    pnl = -trade.stake;
  }

  // Update trade status, PnL, and seq
  sqlite.transaction(() => {
    sqlite.prepare('UPDATE trades SET status = ?, pnl = ?, seq = ? WHERE id = ?').run(
      result === 'WON' ? 'SETTLED' : result === 'VOID' ? 'VOID' : 'SETTLED',
      pnl,
      seq ?? null,
      id
    );

    // Adjust portfolio bankroll
    sqlite.prepare('UPDATE portfolio SET bankroll = bankroll + ?').run(pnl);
  })();
}

export function resetPortfolio() {
  const sqlite = getDb();
  sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM trades').run();
    sqlite.prepare('UPDATE portfolio SET bankroll = ?').run(10000.0);
  })();
}
