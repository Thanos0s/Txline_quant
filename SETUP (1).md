# TxLINE Quant Trading Agent — Setup Checklist

Nothing in this project requires a dataset download. Fixtures, odds, scores, and
historical replay all come live from the TxLINE API once your wallet is
subscribed and your API token is activated. The only thing you actually clone
is TxODDS' own reference repo, because it holds the Anchor IDL/types you need.

Stack decision: **one language, TypeScript/Node, end to end.** TxLINE's own
SDK examples (subscribe, activate, validateStat/validateStatV2) are Node-only.
Reimplementing that in Python means hand-rolling Anchor/Borsh serialization —
not a good use of a week. The Poisson model, edge detection, Kelly sizing, and
backtester are all plain math; none of it needs Python's ecosystem. A Python
sidecar is listed as an optional path at the bottom if you already have model
code you want to keep.

---

## 0. Prerequisites (install once, system-level)

| Tool | Why | Check |
|---|---|---|
| Node.js 20+ | Required — TxLINE's SSE examples pin this in their lockfile | `node -v` |
| npm (or pnpm) | Package manager | `npm -v` |
| Git | Clone the reference repo | `git --version` |
| Solana CLI *(optional but recommended)* | Devnet airdrops, balance checks, debugging | `solana --version` |

---

## 1. Wallet & network setup

Pick **one network** and stay consistent everywhere (RPC URL, program ID, API
host, and IDL must all match — mixing devnet/mainnet values is the single
most common activation failure per TxODDS' own troubleshooting docs).

| Network | Program ID | API host | Free service levels |
|---|---|---|---|
| Devnet | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | `https://txline-dev.txodds.com` | SL 1 |
| Mainnet | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | `https://txline.txodds.com` | SL 1 (60s delay), SL 12 (real-time) |

Start on **devnet** — free, no real funds at risk, same API shape as mainnet.

```bash
solana-keygen new --outfile ./wallet-devnet.json
solana airdrop 2 $(solana-keygen pubkey ./wallet-devnet.json) --url devnet
```

You still need SOL even on the free tier — it pays transaction fees and
account rent for the on-chain `subscribe` call. No TxL purchase is required
for the World Cup free tier.

---

## 2. Clone the one repo you actually need

```bash
git clone https://github.com/txodds/tx-on-chain.git reference/tx-on-chain
```

Pull from it:
- `idl/txoracle.json` (devnet and mainnet variants) — the Anchor IDL
- `types/txoracle.ts` — matching generated TypeScript types
- `examples/devnet/scripts/` — runnable subscribe/activate/validateStat/validateStatV2 scripts to copy and adapt

Do not try to write the IDL or PDA derivation logic yourself — copy it from
here and modify.

---

## 3. Get API access (this replaces "downloading data")

1. `POST {apiOrigin}/auth/guest/start` → guest JWT
2. Call the on-chain `subscribe(serviceLevelId, durationWeeks)` method (service level `1`) → transaction signature
3. Sign the message `${txSig}::${jwt}` with your wallet
4. `POST {apiOrigin}/api/token/activate` with `{ txSig, walletSignature, leagues: [] }` → API token
5. From here on, every data call uses `Authorization: Bearer {jwt}` + `X-Api-Token: {apiToken}`

Once activated, fixtures/odds/scores/historical/proof endpoints are all just
authenticated HTTP calls — nothing to download in advance.

---

## 4. PRD module → what it actually needs

| PRD module | Needs | Package / tool |
|---|---|---|
| 4.1 Data Ingestion | HTTP + SSE stream | native `fetch` (Node 20+), `axios` |
| 4.2 Feature Engine | arithmetic only | none — plain TS |
| 4.3 Fair Price Model (Poisson) | Poisson PMF/CDF | none — ~50 lines of TS (or `jstat` if you want a stats lib) |
| 4.4 Edge Detection | subtraction | none |
| 4.5 Strategy Engine | rule evaluation | none — plain functions |
| 4.6 Risk Manager (Kelly + caps + kill switch) | one formula + guards | none |
| 4.7 Execution Simulator | arithmetic | none |
| 4.8 Backtesting Engine | iterate Historical Replay chronologically | custom loop + `better-sqlite3` for storing results |
| 4.9 Edge Decay Tracker | timestamp diffing | `dayjs` *(optional convenience)* |
| 4.10 Signal vs Market Lag | timestamp diffing | same as above |
| 4.11 Regime Detection | classification rules | none |
| 4.12 Explainable Trade Logs | deterministic template + optional narration | plain template strings; Anthropic API only if you want LLM-written narration *(never for the decision itself)* |
| 4.13 Deterministic Replay Hashing | hash config + inputs | Node built-in `crypto` (`createHash('sha256')`) |
| 4.14 UI Dashboard | React app, charts | `vite`, `react`, `recharts` |
| On-chain settlement *(optional, per your PRD)* | Anchor program calls, Merkle proof validation | `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, `tweetnacl` |

Notice how much of the table says "none" — this is intentional. Most of your
differentiator is arithmetic you write yourself, not a library you import.

---

## 5. Install (backend + frontend, one `npm install`)

See `package.json` in this same output — copy it into your repo root and run:

```bash
npm install
```

## 6. Environment variables

See `.env.example` in this same output. Copy to `.env` and fill in your
wallet path and network choice.

---

## 7. Explicitly do NOT install

Carried over from your PRD's non-goals, confirmed:

- `freqtrade`, `backtrader`, `vectorbt` — built for candle-bar exchange data, not discrete match events; forcing the fit costs more time than it saves
- Kafka — one SSE feed doesn't need a message broker
- AutoGPT / CrewAI — nondeterministic, conflicts directly with "deterministic strategy engine" in your own PRD
- `pyportfolioopt` / `riskfolio-lib` — solves mean-variance portfolio optimization, not the two-line Kelly formula you actually need

---

## 8. Optional: Python sidecar (only if you already have Python quant code)

```
fastapi
uvicorn[standard]
numpy
scipy
python-dotenv
requests
```

Run as a small internal service the Node backend calls for the Poisson
calculation only. Adds a second process to manage — skip unless you have a
concrete reason to keep Python in the loop.

---

## 9. Quick-start order

1. Wallet + devnet SOL (Section 1)
2. Clone reference repo, copy IDL/types (Section 2)
3. Subscribe → activate → confirm one successful `fixtures` API call (Section 3)
4. `npm install` (Section 5), fill `.env` (Section 6)
5. Build ingestion layer first — everything downstream depends on it working
6. Poisson model → edge detection → strategy engine → risk manager (in that order, each one testable in isolation before wiring the next)
7. Backtester against Historical Replay
8. UI + logs last — it's the least risky part and easiest to rush at the end
