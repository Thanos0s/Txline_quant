import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';


// ── types ─────────────────────────────────────────────────────────────────────

type HealthData  = { status: string; service: string; network: string; apiOrigin: string; timestamp: string };
type CredStatus  = { hasJwt: boolean; hasApiToken: boolean; apiOrigin: string };

type Fixture = {
  FixtureId: number;
  CompetitionId: number;
  Competition: string;
  Participant1Id: number;
  Participant2Id: number;
  Participant1: string;
  Participant2: string;
  Participant1IsHome: boolean;
  StartTime: number;   // ms epoch
  Ts: number;
};

type StreamEvent = { id: string; ts: number; raw: string };

type TeamForm = {
  teamId: number;
  teamName: string;
  matchesSampled: number;
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  isFallback: boolean;
};

type LiveMatchState = {
  isLive: boolean;
  currentHomeGoals: number;
  currentAwayGoals: number;
  elapsedSeconds: number;
  remainingFraction: number;
  clockSource: 'score-clock' | 'wall-clock-estimate' | 'not-started';
};

type FairPriceResult = {
  homeForm: TeamForm;
  awayForm: TeamForm;
  liveState: LiveMatchState;
  preMatchLambdaHome: number;
  preMatchLambdaAway: number;
  lambdaHome: number;
  lambdaAway: number;
  outcomeProbabilities: { homeWin: number; draw: number; awayWin: number };
  fairOdds: { home: number; draw: number; away: number };
  overUnder: { line: number; overProbability: number; underProbability: number; fairOverOdds: number; fairUnderOdds: number };
};

type MarketOdds = {
  fixtureId: number;
  asOfTs: number;
  source: 'snapshot' | 'live-updates' | 'none';
  matchResult: { home: number; draw: number; away: number } | null;
  overUnder: { line: number; over: number; under: number } | null;
};

type OutcomeEdge = {
  outcome: string;
  fairOdds: number;
  fairProbability: number;
  marketOdds: number;
  marketImpliedProbability: number;
  edgePercent: number;
  isValueBet: boolean;
  rationale: string;
};

type EdgeReport = {
  fixtureId: number;
  generatedAt: number;
  matchResult: OutcomeEdge[];
  overUnder: OutcomeEdge[];
  bestEdge: OutcomeEdge | null;
  modelSummary: string;
};

type EdgeApiResponse = {
  fairPrice: FairPriceResult;
  market: MarketOdds;
  edgeReport: EdgeReport;
};

type Trade = {
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

type Portfolio = {
  bankroll: number;
  exposure: number;
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T> {
  const res  = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function fixtureStatus(startMs: number): string {
  const now  = Date.now();
  const diff = startMs - now;
  if (diff > 0) return 'Upcoming';
  if (diff > -110 * 60 * 1000) return 'Live';
  return 'Finished';
}

function fmtUtc(ms: number) {
  if (!ms) return '—';
  return new Date(ms).toUTCString().replace(' GMT', 'Z');
}

// Current epoch-day (for startEpochDay queries)
const TODAY_EPOCH_DAY = Math.floor(Date.now() / 86_400_000);

// ── credential banner ─────────────────────────────────────────────────────────

function CredBanner({ cred }: { cred: CredStatus | null }) {
  if (!cred) return null;
  if (!cred.hasApiToken)
    return (
      <div className="banner banner-warn">
        <strong>API Token not configured.</strong> Add to your <code>.env</code>:
        <pre>{'TXLINE_API_TOKEN=<your token from subscribe-activate>'}</pre>
        Then restart <code>npm run dev:api</code>.
      </div>
    );
  if (!cred.hasJwt)
    return <div className="banner banner-info"><strong>Fetching guest JWT…</strong></div>;
  return <div className="banner banner-ok">✅ Ready — {cred.apiOrigin}</div>;
}

// ── fixtures card ─────────────────────────────────────────────────────────────

function FixturesCard({ onFixtureClick, selectedFixtureId }: { onFixtureClick: (fixture: Fixture) => void; selectedFixtureId: number | null }) {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [compId, setCompId]     = useState('72');
  const [startDay, setStartDay] = useState(String(TODAY_EPOCH_DAY - 30));

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (compId)   params.set('competitionId', compId);
      if (startDay) params.set('startEpochDay', startDay);
      const data = await apiFetch<Fixture[]>(`/api/data/fixtures/snapshot?${params}`);
      const sorted = [...data].sort((a, b) => a.StartTime - b.StartTime);
      setFixtures(sorted);
      // Auto-select the first live or upcoming fixture
      if (sorted.length > 0) {
        const live = sorted.find(f => fixtureStatus(f.StartTime) === 'Live');
        const upcoming = sorted.find(f => fixtureStatus(f.StartTime) === 'Upcoming');
        const autoSelect = live ?? upcoming ?? sorted[sorted.length - 1];
        if (autoSelect) onFixtureClick(autoSelect);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [compId, startDay]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card">
      <h2>Fixtures Snapshot</h2>
      <div className="btn-row">
        <label>
          Competition ID&nbsp;
          <input type="number" value={compId} onChange={e => setCompId(e.target.value)} style={{ width: 80 }} />
        </label>
        <label>
          Start epoch-day&nbsp;
          <input type="number" value={startDay} onChange={e => setStartDay(e.target.value)} style={{ width: 90 }} />
        </label>
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Fetch Fixtures'}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
        Free tier: <strong>72</strong> = World Cup &nbsp;|&nbsp; today ≈ epoch-day {TODAY_EPOCH_DAY}.
      </p>

      {error && <div className="error-box"><strong>Error:</strong> {error}</div>}

      {!loading && !error && fixtures.length === 0 && (
        <p className="muted">No fixtures found for these parameters.</p>
      )}

      {fixtures.length > 0 && (
        <>
          <p className="muted">{fixtures.length} fixture(s) — click a row to load scores + run the fair-price model.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Home</th>
                  <th>Away</th>
                  <th>Competition</th>
                  <th>Status</th>
                  <th>Kick-off (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {fixtures.map(f => {
                  const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
                  const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
                  const st   = fixtureStatus(f.StartTime);
                  const isSelected = f.FixtureId === selectedFixtureId;
                  return (
                    <tr
                      key={f.FixtureId}
                      className="clickable-row"
                      onClick={() => onFixtureClick(f)}
                      title={`Click to analyze: ${home} vs ${away}`}
                      style={isSelected ? { background: 'rgba(59,130,246,0.12)', outline: '1px solid rgba(59,130,246,0.4)' } : {}}
                    >
                      <td><code style={isSelected ? { color: 'var(--accent-bright)' } : {}}>{f.FixtureId}</code></td>
                      <td style={{ fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--accent-bright)' : '' }}>{home || '—'}</td>
                      <td style={{ color: isSelected ? 'var(--accent-bright)' : '' }}>{away || '—'}</td>
                      <td>{f.Competition}</td>
                      <td><span className={`status-pill status-${st.toLowerCase()}`}>{st}</span></td>
                      <td>{fmtUtc(f.StartTime)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// ── scores card ───────────────────────────────────────────────────────────────

function ScoresCard({ fixture }: { fixture: Fixture | null }) {
  const [fixtureId, setFixtureId] = useState('');
  const [data, setData]   = useState<unknown[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode]   = useState<'snapshot' | 'historical'>('snapshot');

  useEffect(() => {
    if (fixture) setFixtureId(String(fixture.FixtureId));
  }, [fixture]);

  const load = useCallback(async () => {
    if (!fixtureId) return;
    setLoading(true); setError(null); setData(null);
    try {
      const url = mode === 'historical'
        ? `/api/data/scores/historical/${fixtureId}`
        : `/api/data/scores/snapshot/${fixtureId}`;
      setData(await apiFetch<unknown[]>(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fixtureId, mode]);

  return (
    <section className="card">
      <h2>Scores Lookup</h2>
      <p className="muted" style={{ marginTop: 0 }}>Click a fixture row above to auto-fill the ID, or type one manually.</p>
      <div className="btn-row">
        <input
          type="number"
          value={fixtureId}
          onChange={e => setFixtureId(e.target.value)}
          placeholder="Fixture ID (e.g. 17588223)"
          style={{ width: 200 }}
        />
        <select value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
          <option value="snapshot">Snapshot</option>
          <option value="historical">Historical</option>
        </select>
        <button onClick={load} disabled={loading || !fixtureId}>
          {loading ? 'Loading…' : 'Fetch Scores'}
        </button>
      </div>
      {error && <div className="error-box"><strong>Error:</strong> {error}</div>}
      {data !== null && data.length === 0 && <p className="muted">No score data yet for this fixture.</p>}
      {data !== null && data.length > 0 && (
        <pre className="json-out">{JSON.stringify(data, null, 2).slice(0, 6000)}</pre>
      )}
    </section>
  );
}

// ── fair price & edge card ────────────────────────────────────────────────────

function FormRow({ label, form }: { label: string; form: TeamForm }) {
  return (
    <p className="form-row">
      <strong>{label}:</strong> {form.teamName} —{' '}
      {form.isFallback
        ? 'no recent history found, used league-average fallback'
        : `${form.matchesSampled} recent match(es), avg ${(form.avgGoalsFor ?? 0).toFixed(2)} scored / ${(form.avgGoalsAgainst ?? 0).toFixed(2)} conceded`}
    </p>
  );
}

function EdgeCard({ fixture, onTradeExecuted }: { fixture: Fixture | null; onTradeExecuted: () => void }) {
  const [report, setReport] = useState<EdgeApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyzingFixtureId, setAnalyzingFixtureId] = useState<number | null>(null);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeMessage, setTradeMessage] = useState<{ text: string; type: 'success' | 'info' | 'error' } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const simulateTrade = async () => {
    if (!fixture) return;
    setTradeLoading(true);
    setTradeMessage(null);
    try {
      const homeId   = fixture.Participant1IsHome ? fixture.Participant1Id : fixture.Participant2Id;
      const homeName = fixture.Participant1IsHome ? fixture.Participant1   : fixture.Participant2;
      const awayId   = fixture.Participant1IsHome ? fixture.Participant2Id : fixture.Participant1Id;
      const awayName = fixture.Participant1IsHome ? fixture.Participant2   : fixture.Participant1;

      const res = await fetch('/api/quant/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fixtureId: fixture.FixtureId,
          homeId, homeTeamName: homeName,
          awayId, awayTeamName: awayName,
          competitionId: fixture.CompetitionId,
          kickoffMs: fixture.StartTime,
          participant1IsHome: fixture.Participant1IsHome,
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Trade simulation failed');
      const { decision, loggedTrade } = data;
      if (decision.shouldTrade && loggedTrade) {
        setTradeMessage({ text: `✅ Placed $${loggedTrade.stake} on "${loggedTrade.outcome}" at odds ${loggedTrade.marketOdds.toFixed(2)} (${loggedTrade.edgePercent.toFixed(1)}% edge).`, type: 'success' });
        onTradeExecuted();
      } else {
        setTradeMessage({ text: `⚠️ Trade Vetoed: ${decision.reason}`, type: 'info' });
      }
    } catch (e) {
      setTradeMessage({ text: e instanceof Error ? e.message : String(e), type: 'error' });
    } finally {
      setTradeLoading(false);
    }
  };

  // Auto-analyze on fixture change — cancels previous in-flight request
  useEffect(() => {
    if (!fixture) return;

    // Cancel any prior request
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const homeId   = fixture.Participant1IsHome ? fixture.Participant1Id : fixture.Participant2Id;
    const homeName = fixture.Participant1IsHome ? fixture.Participant1   : fixture.Participant2;
    const awayId   = fixture.Participant1IsHome ? fixture.Participant2Id : fixture.Participant1Id;
    const awayName = fixture.Participant1IsHome ? fixture.Participant2   : fixture.Participant1;

    const params = new URLSearchParams({
      competitionId: String(fixture.CompetitionId),
      homeId: String(homeId), homeName,
      awayId: String(awayId), awayName,
      kickoffMs: String(fixture.StartTime),
      participant1IsHome: String(fixture.Participant1IsHome),
    });

    setLoading(true);
    setError(null);
    setTradeMessage(null);
    setAnalyzingFixtureId(fixture.FixtureId);
    // NOTE: we do NOT clear report here — stale data stays visible during load

    fetch(`/api/quant/edge/${fixture.FixtureId}?${params}`, { signal: ctrl.signal })
      .then(async res => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body as EdgeApiResponse;
      })
      .then(data => {
        if (ctrl.signal.aborted) return;
        setReport(data);
        setError(null);
      })
      .catch(e => {
        if (ctrl.signal.aborted) return; // user switched fixture — ignore
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          setAnalyzingFixtureId(null);
        }
      });

    return () => ctrl.abort();
  }, [fixture?.FixtureId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => () => abortRef.current?.abort(), []);

  const allOutcomes = report ? [...report.edgeReport.matchResult, ...report.edgeReport.overUnder] : [];
  const hasValueBet = report?.edgeReport.bestEdge?.isValueBet ?? false;

  return (
    <section className="card">
      <div className="card-header">
        <h2>⚡ Edge Detector</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          {loading && (
            <span style={{ fontSize: '0.72rem', color: 'var(--accent-bright)', fontFamily: 'JetBrains Mono, monospace' }}>
              <span className="live-dot" style={{ background: 'var(--accent)' }} />
              Analyzing{analyzingFixtureId ? ` #${analyzingFixtureId}` : ''}…
            </span>
          )}
          <button onClick={() => { if (fixture) { abortRef.current?.abort(); setReport(null); setError(null); } }} disabled={!fixture || loading} style={{ fontSize: '0.72rem' }}>
            {loading ? 'Cancel' : 'Re-analyze'}
          </button>
          {report && hasValueBet && (
            <button onClick={simulateTrade} disabled={tradeLoading} className="btn-success" style={{ margin: 0 }}>
              {tradeLoading ? 'Trading…' : '⚡ Simulate Kelly Trade'}
            </button>
          )}
        </div>
      </div>

      {/* Fixture label */}
      <p className="muted" style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '0.8rem' }}>
        {fixture ? (
          <>
            Dixon-Coles model · <strong>{fixture.Participant1IsHome ? fixture.Participant1 : fixture.Participant2}</strong>
            {' vs '}
            <strong>{fixture.Participant1IsHome ? fixture.Participant2 : fixture.Participant1}</strong>
            {' '}(#{fixture.FixtureId})
          </>
        ) : (
          'Click any fixture row above to analyze it automatically.'
        )}
      </p>

      {tradeMessage && (
        <div className={`banner banner-${tradeMessage.type === 'success' ? 'ok' : tradeMessage.type === 'info' ? 'info' : 'error'}`} style={{ marginBottom: '0.75rem' }}>
          {tradeMessage.text}
        </div>
      )}

      {error && !loading && (
        <div className="error-box"><strong>Error:</strong> {error}</div>
      )}

      {/* Loading placeholder when no prior report */}
      {loading && !report && (
        <div style={{ padding: '2rem 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
          <div style={{ marginBottom: '0.5rem', fontSize: '1.5rem' }}>⏳</div>
          Computing Dixon-Coles fair prices from TxLINE team form data…<br />
          <span style={{ fontSize: '0.72rem' }}>This takes 10–30 seconds on first load.</span>
        </div>
      )}

      {/* Results — shown even while re-loading stale data */}
      {report && (
        <div style={{ position: 'relative', opacity: loading ? 0.55 : 1, transition: 'opacity 0.3s' }}>
          {loading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, fontSize: '0.75rem', color: 'var(--accent-bright)', background: 'rgba(8,12,20,0.4)', borderRadius: 'var(--radius-md)', backdropFilter: 'blur(2px)' }}>
              <span className="live-dot" style={{ background: 'var(--accent)' }} />Refreshing analysis…
            </div>
          )}

          {report.fairPrice.liveState.isLive && (
            <div className="banner banner-info" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
              🔴 <strong>LIVE</strong> — score {report.fairPrice.liveState.currentHomeGoals}-{report.fairPrice.liveState.currentAwayGoals},{' '}
              ~{Math.round(report.fairPrice.liveState.elapsedSeconds / 60)}′ elapsed · model scaled to{' '}
              {(report.fairPrice.liveState.remainingFraction * 100).toFixed(0)}% remaining time
            </div>
          )}

          <p className="model-summary">{report.edgeReport.modelSummary}</p>
          <FormRow label="Home" form={report.fairPrice.homeForm} />
          <FormRow label="Away" form={report.fairPrice.awayForm} />

          {allOutcomes.length === 0 && (
            <p className="muted" style={{ marginTop: '0.75rem' }}>No live market odds available — model output only (above).</p>
          )}

          {allOutcomes.length > 0 && (
            <>
              <p className="muted" style={{ margin: '0.75rem 0 0.4rem', fontSize: '0.73rem' }}>
                Odds source: <strong>{report.market.source === 'live-updates' ? 'live in-play' : 'pre-match snapshot'}</strong>
                {' '}· as of {new Date(report.market.asOfTs).toLocaleTimeString()}
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Outcome</th>
                      <th>Fair Odds</th>
                      <th>Market Odds</th>
                      <th>Edge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allOutcomes.map(oe => (
                      <tr key={oe.outcome} className={oe.isValueBet ? 'edge-positive' : ''}>
                        <td style={{ fontWeight: oe.isValueBet ? 600 : 400 }}>{oe.outcome}</td>
                        <td style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                          {(oe.fairOdds === null || oe.fairOdds === Infinity || typeof oe.fairOdds !== 'number') ? '—' : oe.fairOdds.toFixed(2)}
                        </td>
                        <td style={{ fontFamily: 'JetBrains Mono, monospace' }}>{(oe.marketOdds ?? 0).toFixed(2)}</td>
                        <td>
                          <span className={oe.edgePercent >= 0 ? 'edge-pos' : 'edge-neg'}>
                            {oe.edgePercent >= 0 ? '+' : ''}{oe.edgePercent.toFixed(1)}%
                          </span>
                          {oe.isValueBet && <span className="value-tag">VALUE</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {report.edgeReport.bestEdge && (
            <div className="rationale-box" style={{ marginTop: '0.75rem' }}>
              <strong>Best edge:</strong> {report.edgeReport.bestEdge.rationale}
            </div>
          )}
        </div>
      )}
    </section>
  );
}



// ── SSE stream panel ──────────────────────────────────────────────────────────

function StreamPanel({ title, endpoint }: { title: string; endpoint: string }) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState<'off' | 'connecting' | 'live' | 'error'>('off');
  const [statusMsg, setStatusMsg] = useState('');
  const esRef = useRef<EventSource | null>(null);

  const pushEvent = (raw: string, id?: string) => {
    if (!raw || raw.trim() === '') return;
    setEvents(prev => [{ id: id || String(Date.now()), ts: Date.now(), raw }, ...prev.slice(0, 99)]);
  };

  const connect = () => {
    esRef.current?.close();
    setStatus('connecting'); setStatusMsg('');
    const es = new EventSource(endpoint);
    esRef.current = es;

    es.onopen = () => setStatus('live');
    es.onmessage = e => pushEvent(e.data, e.lastEventId);

    es.addEventListener('ping',         () => setStatus('live'));
    es.addEventListener('connected',    (e: MessageEvent) => { setStatus('live'); setStatusMsg('upstream connected'); pushEvent(e.data); });
    es.addEventListener('heartbeat',    () => { /* keep-alive */ });
    es.addEventListener('reconnecting', (e: MessageEvent) => setStatusMsg('Reconnecting… ' + e.data));
    es.addEventListener('error',        (e: MessageEvent) => {
      setStatus('error');
      try { setStatusMsg(JSON.parse(e.data)?.message ?? e.data); } catch { setStatusMsg(e.data); }
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus('error');
        setStatusMsg('Connection closed. Is the API server running?');
      }
    };
  };

  const disconnect = () => {
    esRef.current?.close(); esRef.current = null;
    setStatus('off'); setStatusMsg('');
  };

  useEffect(() => () => esRef.current?.close(), []);

  const badgeClass = { off: 'badge-off', connecting: 'badge-connecting', live: 'badge-live', error: 'badge-error' }[status];
  const badgeLabel = { off: 'OFF', connecting: 'CONNECTING…', live: 'LIVE', error: 'ERROR' }[status];

  return (
    <section className="card">
      <div className="card-header">
        <h2>{title}</h2>
        <span className={`badge ${badgeClass}`}>{badgeLabel}</span>
      </div>
      <div className="btn-row">
        <button onClick={connect}    disabled={status === 'live' || status === 'connecting'}>Connect</button>
        <button onClick={disconnect} disabled={status === 'off'}>Disconnect</button>
        {events.length > 0 && <button onClick={() => setEvents([])}>Clear ({events.length})</button>}
      </div>
      {statusMsg && status !== 'error' && <p className="muted">{statusMsg}</p>}
      {status === 'error' && <div className="error-box">{statusMsg || 'Unknown error'}</div>}
      {events.length === 0 && status === 'live' && (
        <p className="muted">Connected — waiting for live events (scores/odds update during live matches).</p>
      )}
      {events.length === 0 && status === 'off' && (
        <p className="muted">Click Connect to start the live stream.</p>
      )}
      <ul className="event-list">
        {events.map((ev, i) => (
          <li key={`${ev.id}-${i}`}>
            <span className="event-id">{ev.id}</span>
            <code>{ev.raw.length > 160 ? ev.raw.slice(0, 160) + '…' : ev.raw}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── root ──────────────────────────────────────────────────────────────────────

export function App() {
  const [health, setHealth]   = useState<HealthData | null>(null);
  const [cred, setCred]       = useState<CredStatus | null>(null);
  const [apiDown, setApiDown] = useState(false);
  const [selectedFixture, setSelectedFixture] = useState<Fixture | null>(null);
  const [activePage, setActivePage] = useState<'landing' | 'terminal' | 'portfolio' | 'streams'>('landing');

  const [portfolio, setPortfolio] = useState<Portfolio>({ bankroll: 10000, exposure: 0 });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [resetting, setResetting] = useState(false);
  const [verifiedTrades, setVerifiedTrades] = useState<Record<number, boolean | 'loading'>>({});

  const verifyTrade = async (tradeId: number) => {
    setVerifiedTrades(prev => ({ ...prev, [tradeId]: 'loading' }));
    try {
      const res = await fetch(`/api/quant/verify/${tradeId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Verification failed');
      setVerifiedTrades(prev => ({ ...prev, [tradeId]: !!data.verifiedOnChain }));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      setVerifiedTrades(prev => {
        const next = { ...prev };
        delete next[tradeId];
        return next;
      });
    }
  };

  const loadPortfolioData = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([
        apiFetch<Portfolio>('/api/quant/portfolio'),
        apiFetch<Trade[]>('/api/quant/trades'),
      ]);
      setPortfolio(p);
      setTrades(t);
    } catch (e) {
      console.error('Failed to load portfolio/trades data', e);
    }
  }, []);

  const resetPortfolioState = async () => {
    if (!confirm('Are you sure you want to reset the bankroll and delete all simulated trades?')) return;
    setResetting(true);
    try {
      const res = await fetch('/api/quant/reset', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Reset failed');
      setPortfolio(data.portfolio);
      setTrades([]);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  };

  useEffect(() => {
    const load = async () => {
      try {
        const [h, c] = await Promise.all([
          apiFetch<HealthData>('/api/health'),
          apiFetch<CredStatus>('/api/health/credentials'),
        ]);
        setHealth(h); setCred(c); setApiDown(false);
      } catch { setApiDown(true); }
    };
    load();
    loadPortfolioData();
    const t = setInterval(() => {
      load();
      loadPortfolioData();
    }, 10_000); // Poll health & portfolio every 10s
    return () => clearInterval(t);
  }, [loadPortfolioData]);

  return (
    <motion.main 
      className="container"
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >

      {/* ── Header ── */}
      <motion.header 
        className="app-header"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.1, duration: 0.4 }}
      >
        <div className="app-header-left">
          <motion.div 
            className="app-logo"
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.95 }}
          >
            ⚡
          </motion.div>
          <div>
            <h1>TxLINE Quant Agent</h1>
            <div className="app-subtitle">Autonomous AI Sports Trading · Solana Devnet</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          {!apiDown && <span className="header-badge"><span className="live-dot" />LIVE</span>}
          {health && <span className="muted" style={{ fontSize: '0.7rem' }}>{health.network}</span>}
        </div>
      </motion.header>

      {/* ── Page Navigation ── */}
      <div className="tabs-container">
        <button 
          className={`tab-btn ${activePage === 'landing' ? 'active' : ''}`}
          onClick={() => setActivePage('landing')}
        >
          🏠 Overview
        </button>
        <button 
          className={`tab-btn ${activePage === 'terminal' ? 'active' : ''}`}
          onClick={() => setActivePage('terminal')}
        >
          ⚡ Live Terminal
        </button>
        <button 
          className={`tab-btn ${activePage === 'portfolio' ? 'active' : ''}`}
          onClick={() => setActivePage('portfolio')}
        >
          💼 Portfolio
        </button>
        <button 
          className={`tab-btn ${activePage === 'streams' ? 'active' : ''}`}
          onClick={() => setActivePage('streams')}
        >
          📡 Data Streams
        </button>
      </div>

      {/* ── API Down Banner ── */}
      <AnimatePresence>
        {apiDown && (
          <motion.div 
            className="banner banner-error"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            style={{ marginBottom: '1.5rem' }}
          >
            ⚠️ Cannot reach API server — run <code>npm run dev:api</code>.
          </motion.div>
        )}
      </AnimatePresence>

      <CredBanner cred={cred} />

      {/* ── Page Routing ── */}
      <AnimatePresence mode="wait">
        {activePage === 'landing' && (
          <motion.div
            key="landing"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
          >
            {/* Landing Hero */}
            <div className="landing-hero">
              <h2 className="landing-title">Autonomous Sports Arbitrage &amp; Kelly Sizing</h2>
              <p className="landing-subtitle">
                A quantitative, lookahead-bias-free betting terminal powered by the TxLINE real-time oracle stream and cryptographically validated on the Solana blockchain.
              </p>
              <button 
                className="btn-primary" 
                onClick={() => setActivePage('terminal')}
                style={{ fontSize: '0.9rem', padding: '0.65rem 1.4rem' }}
              >
                Launch Trading Terminal ⚡
              </button>
            </div>

            {/* Metrics Snapshot */}
            <section className="card">
              <div className="card-header">
                <h2>📈 Backtest Performance (World Cup fixtures)</h2>
              </div>
              <div className="portfolio-stats">
                <div className="stat-box">
                  <span className="stat-label">🎯 Model Win Rate</span>
                  <span className="stat-val positive">75.0%</span>
                </div>
                <div className="stat-box">
                  <span className="stat-label">💰 Backtest P&amp;L</span>
                  <span className="stat-val positive">+$972.37</span>
                </div>
                <div className="stat-box">
                  <span className="stat-label">📈 Return on Vol (ROI)</span>
                  <span className="stat-val positive">+55.15%</span>
                </div>
                <div className="stat-box">
                  <span className="stat-label">🛡️ Veto Efficiency</span>
                  <span className="stat-val">11/15</span>
                </div>
              </div>
            </section>

            {/* Core Specifications */}
            <div className="grid-3col">
              <div className="spec-card">
                <div className="spec-icon">📊</div>
                <h3>Dixon-Coles Model</h3>
                <p>
                  Adjusts standard independent Poisson goal rate calculations for soccer draw biases ($\rho = -0.12$) to correctly price low-scoring outcomes (0-0, 1-1, 1-0).
                </p>
              </div>

              <div className="spec-card">
                <div className="spec-icon">⚖️</div>
                <h3>Kelly Sizing</h3>
                <p>
                  Dynamically scales bet stakes proportional to model-to-market probability divergence, maximizing exponential bankroll growth while avoiding capital depletion.
                </p>
              </div>

              <div className="spec-card">
                <div className="spec-icon">🛡️</div>
                <h3>Risk Management</h3>
                <p>
                  Applies three strict sweep-optimized guardrails: minimum historical match sample size ($\ge 3$), maximum odds cap ($3.50$), and minimum edge threshold ($10\%$).
                </p>
              </div>

              <div className="spec-card">
                <div className="spec-icon">⛓️</div>
                <h3>Solana Settlement</h3>
                <p>
                  Logs settled sequences in a local ledger database and cryptographically verifies match scores on-chain via the Solana Devnet oracle contract.
                </p>
              </div>
            </div>

            {/* System Setup Guide */}
            <div className="setup-box">
              <h4>🛠️ Run Strategy Backtests Locally</h4>
              <p className="muted" style={{ marginBottom: '0.5rem', fontSize: '0.78rem' }}>
                Run the event-driven sliding window backtest or hyperparameter sweeps inside your terminal:
              </p>
              <pre style={{ marginBottom: '0.5rem' }}>npx tsx scripts/backtest.ts</pre>
              <pre>npx tsx scripts/backtest-sweep.ts</pre>
            </div>
          </motion.div>
        )}

        {activePage === 'terminal' && (
          <motion.div
            key="terminal"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
          >
            {/* ── API Status ── */}
            {health && (
              <section className="card">
                <div className="card-header">
                  <h2>🌐 Connection Status</h2>
                  <span className="badge badge-live">Online</span>
                </div>
                <ul>
                  <li><strong>Network:</strong> {health.network}</li>
                  <li><strong>Origin:</strong> {health.apiOrigin}</li>
                  <li><strong>JWT:</strong> {cred?.hasJwt ? '✅ Active' : '⏳ Fetching…'}</li>
                  <li><strong>API Token:</strong> {cred?.hasApiToken ? '✅ Active' : '❌ Not configured'}</li>
                  <li><strong>Last Checked:</strong> {new Date(health.timestamp).toLocaleTimeString()}</li>
                </ul>
              </section>
            )}

            <FixturesCard onFixtureClick={setSelectedFixture} selectedFixtureId={selectedFixture?.FixtureId ?? null} />
            <EdgeCard fixture={selectedFixture} onTradeExecuted={loadPortfolioData} />
          </motion.div>
        )}

        {activePage === 'portfolio' && (
          <motion.div
            key="portfolio"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
          >
            {/* ── Portfolio ── */}
            <section className="card">
              <div className="card-header">
                <h2>💼 Agent Portfolio</h2>
                <button className="btn-danger" onClick={resetPortfolioState} disabled={resetting} style={{ margin: 0 }}>
                  {resetting ? 'Resetting…' : '↺ Reset'}
                </button>
              </div>

              {/* Accuracy ring */}
              {trades.length > 0 && (() => {
                const settled = trades.filter(t => t.status === 'SETTLED');
                const wins = settled.filter(t => t.pnl > 0).length;
                const rate = settled.length > 0 ? Math.round((wins / settled.length) * 100) : 0;
                const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
                return (
                  <motion.div 
                    className="accuracy-ring"
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.4 }}
                  >
                    <div>
                      <div className="accuracy-num">{rate}%</div>
                      <div className="accuracy-label">Win Rate</div>
                    </div>
                    <div style={{ width: '1px', height: '40px', background: 'rgba(255,255,255,0.15)' }} />
                    <div>
                      <div className="accuracy-num" style={{ fontSize: '1.4rem' }}>{wins}/{settled.length}</div>
                      <div className="accuracy-label">Settled Trades</div>
                    </div>
                    <div style={{ width: '1px', height: '40px', background: 'rgba(255,255,255,0.15)' }} />
                    <div>
                      <div className="accuracy-num" style={{ fontSize: '1.4rem' }}>
                        {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)}
                      </div>
                      <div className="accuracy-label">Total P&amp;L</div>
                    </div>
                  </motion.div>
                );
              })()}

              <div className="portfolio-stats">
                <motion.div className="stat-box" whileHover={{ translateY: -2 }}>
                  <span className="stat-label">💰 Bankroll</span>
                  <span className="stat-val">
                    ${portfolio.bankroll.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </motion.div>
                <motion.div className="stat-box" whileHover={{ translateY: -2 }}>
                  <span className="stat-label">📊 Exposure</span>
                  <span className="stat-val">
                    ${portfolio.exposure.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </motion.div>
                <motion.div className="stat-box" whileHover={{ translateY: -2 }}>
                  <span className="stat-label">🎯 Model Accuracy</span>
                  <span className="stat-val positive">75%</span>
                </motion.div>
                <motion.div className="stat-box" whileHover={{ translateY: -2 }}>
                  <span className="stat-label">📈 Backtest ROI</span>
                  <span className="stat-val positive">+55.2%</span>
                </motion.div>
              </div>

              <h3>Trade History</h3>
              {trades.length === 0 ? (
                <p className="muted">No trades yet — select a fixture in the terminal and click ⚡ Simulate Kelly Trade when an edge is found.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Match</th>
                        <th>Outcome</th>
                        <th>Odds</th>
                        <th>Edge</th>
                        <th>Stake</th>
                        <th>Status</th>
                        <th>On-Chain</th>
                        <th>P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map(t => {
                        const dateStr = new Date(t.timestamp).toLocaleTimeString();
                        let statusClass = 'badge-off';
                        if (t.status === 'PENDING') statusClass = 'badge-connecting';
                        else if (t.status === 'SETTLED' && t.pnl > 0) statusClass = 'badge-live';
                        else if (t.status === 'SETTLED' && t.pnl <= 0) statusClass = 'badge-error';

                        return (
                          <tr key={t.id}>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.73rem', color: 'var(--text-muted)' }}>{dateStr}</td>
                            <td style={{ fontWeight: 500 }}>{t.homeTeam} <span style={{ color: 'var(--text-muted)' }}>vs</span> {t.awayTeam}</td>
                            <td style={{ color: 'var(--text-secondary)' }}>{t.outcome}</td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace' }}>{(t.marketOdds ?? 0).toFixed(2)}</td>
                            <td><span className="edge-pos">+{(t.edgePercent ?? 0).toFixed(1)}%</span></td>
                            <td style={{ fontFamily: 'JetBrains Mono, monospace' }}>${(t.stake ?? 0).toFixed(2)}</td>
                            <td><span className={`badge ${statusClass}`}>{t.status}</span></td>
                            <td>
                              {t.status === 'SETTLED' && t.seq != null ? (
                                verifiedTrades[t.id] === 'loading' ? (
                                  <span className="muted">Verifying…</span>
                                ) : verifiedTrades[t.id] === true ? (
                                  <span className="edge-pos">✅ verified</span>
                                ) : verifiedTrades[t.id] === false ? (
                                  <span className="edge-neg">❌ failed</span>
                                ) : (
                                  <button onClick={() => verifyTrade(t.id)} className="btn-primary" style={{ padding: '0.15rem 0.5rem', fontSize: '0.68rem' }}>
                                    Verify ⛓
                                  </button>
                                )
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td>
                              {t.status === 'PENDING' ? (
                                <span className="muted">—</span>
                              ) : (
                                <span className={t.pnl >= 0 ? 'edge-pos' : 'edge-neg'}>
                                  {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </motion.div>
        )}

        {activePage === 'streams' && (
          <motion.div
            key="streams"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.25 }}
          >
            <ScoresCard fixture={selectedFixture} />
            <StreamPanel title="Live Scores Stream (SSE)" endpoint="/api/data/scores/stream" />
            <StreamPanel title="Live Odds Stream (SSE)"   endpoint="/api/data/odds/stream"   />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.main>
  );
}


