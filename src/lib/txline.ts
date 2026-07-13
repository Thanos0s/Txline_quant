import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import axios from 'axios';
import nacl from 'tweetnacl';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getEnv, resolveNetworkDefaults, type AppNetwork } from './config';

export type SubscribeInput = {
  serviceLevelId?: number;
  durationWeeks?: number;
  selectedLeagues?: number[];
};

export type ActivateInput = {
  txSig: string;
  jwt: string;
  selectedLeagues?: number[];
};

type TxlineContext = {
  network: AppNetwork;
  apiOrigin: string;
  connection: Connection;
  wallet: anchor.Wallet;
  program: any;
  programId: PublicKey;
  txlTokenMint: PublicKey;
};

function expandHome(pathValue: string): string {
  if (pathValue === '~') {
    return homedir();
  }

  if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) {
    return resolve(homedir(), pathValue.slice(2));
  }

  return pathValue;
}

function resolveProjectPath(pathValue: string): string {
  const expanded = expandHome(pathValue);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

function loadLocalKeypair(pathValue: string): Keypair {
  const fullPath = resolveProjectPath(pathValue);

  if (!existsSync(fullPath)) {
    throw new Error(`Wallet keypair file was not found at: ${fullPath}`);
  }

  const raw = readFileSync(fullPath, 'utf8');
  const secret = JSON.parse(raw) as number[];

  if (!Array.isArray(secret) || secret.length === 0) {
    throw new Error('Wallet keypair file does not contain a valid secret key array');
  }

  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function resolveIdlPath(preferredPath?: string): string {
  const candidates = [
    preferredPath,
    'reference/tx-on-chain/idl/txoracle.json',
    'tx-on-chain-main/examples/devnet/idl/txoracle.json',
    'tx-on-chain-main/examples/mainnet/idl/txoracle.json',
    'tx-on-chain-main/idl/txoracle.json',
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  for (const candidate of candidates) {
    const fullPath = resolveProjectPath(candidate);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  throw new Error(
    'TxLINE IDL file was not found. Set TXLINE_IDL_PATH to your txoracle.json path (for example: tx-on-chain-main/idl/txoracle.json).'
  );
}

function loadIdl(idlPath?: string): anchor.Idl {
  const fullPath = resolveIdlPath(idlPath);
  const raw = readFileSync(fullPath, 'utf8');
  return JSON.parse(raw) as anchor.Idl;
}

function buildContext(): TxlineContext {
  const env = getEnv();
  const defaults = resolveNetworkDefaults(env.SOLANA_NETWORK);

  const rpcUrl = env.SOLANA_RPC_URL ?? defaults.rpcUrl;
  const apiOrigin = env.TXLINE_API_ORIGIN ?? defaults.apiOrigin;
  const programId = new PublicKey(env.TXLINE_PROGRAM_ID ?? defaults.programId);
  const txlTokenMint = new PublicKey(env.TXLINE_TXL_MINT ?? defaults.txlTokenMint);
  const idlPath = env.TXLINE_IDL_PATH;

  const keypairPath = env.WALLET_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new Error('WALLET_KEYPAIR_PATH is required to sign subscribe and activate operations');
  }

  const keypair = loadLocalKeypair(keypairPath);
  const wallet = new anchor.Wallet(keypair);

  const connection = new Connection(rpcUrl, 'confirmed');
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });

  const idl = loadIdl(idlPath);
  const idlWithAddress =
    'address' in idl && typeof idl.address === 'string'
      ? idl
      : ({ ...idl, address: programId.toBase58() } as anchor.Idl);

  const program = new anchor.Program(idlWithAddress, provider);

  if (!program.programId.equals(programId)) {
    throw new Error(
      `Loaded IDL program ${program.programId.toBase58()} does not match configured program ${programId.toBase58()}`
    );
  }

  return {
    network: env.SOLANA_NETWORK,
    apiOrigin,
    connection,
    wallet,
    program,
    programId,
    txlTokenMint,
  };
}

function deriveSubscriptionAccounts(ctx: TxlineContext) {
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_treasury_v2')],
    ctx.program.programId
  );

  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    ctx.txlTokenMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pricing_matrix')],
    ctx.program.programId
  );

  const userTokenAccount = getAssociatedTokenAddressSync(
    ctx.txlTokenMint,
    ctx.wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return {
    user: ctx.wallet.publicKey,
    pricingMatrix: pricingMatrixPda,
    tokenMint: ctx.txlTokenMint,
    userTokenAccount,
    tokenTreasuryVault,
    tokenTreasuryPda,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

export async function requestGuestJwt() {
  const ctx = buildContext();
  const response = await axios.post(`${ctx.apiOrigin}/auth/guest/start`);
  const jwt = response.data?.token;

  if (!jwt || typeof jwt !== 'string') {
    throw new Error('Guest auth response did not include a token');
  }

  return {
    network: ctx.network,
    apiOrigin: ctx.apiOrigin,
    jwt,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function subscribeOnChain(input: SubscribeInput = {}) {
  const env = getEnv();
  const ctx = buildContext();

  const serviceLevelId = input.serviceLevelId ?? env.SERVICE_LEVEL_ID;
  const durationWeeks = input.durationWeeks ?? env.DURATION_WEEKS;
  const selectedLeagues = input.selectedLeagues ?? [];

  if (durationWeeks < 4 || durationWeeks % 4 !== 0) {
    throw new Error(`Invalid durationWeeks: ${durationWeeks}. Must be a multiple of 4.`);
  }

  const userTokenAccountAddress = getAssociatedTokenAddressSync(
    ctx.txlTokenMint,
    ctx.wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Create the user's Token-2022 ATA if it doesn't exist yet
  const accountInfo = await ctx.connection.getAccountInfo(userTokenAccountAddress);
  if (!accountInfo) {
    console.log('User TxL token account not found — creating it...');
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        ctx.wallet.publicKey,
        userTokenAccountAddress,
        ctx.wallet.publicKey,
        ctx.txlTokenMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(ctx.connection, createAtaTx, [ctx.wallet.payer], {
      commitment: 'confirmed',
    });
    console.log('Token account created. Waiting for RPC to sync...');
    await delay(3000);
  }

  // Verify the ATA is live (retry up to 5×)
  let attempts = 0;
  while (attempts < 5) {
    try {
      await getAccount(ctx.connection, userTokenAccountAddress, 'confirmed', TOKEN_2022_PROGRAM_ID);
      break;
    } catch (err: any) {
      if (err.name === 'TokenAccountNotFoundError') {
        attempts++;
        console.log(`RPC not synced yet. Retrying (${attempts}/5)...`);
        await delay(2000);
      } else {
        throw err;
      }
    }
  }

  const accounts = deriveSubscriptionAccounts(ctx);

  // Build → sign → send manually (same as reference examples)
  const tx = await ctx.program.methods
    .subscribe(serviceLevelId, durationWeeks)
    .accounts({ ...accounts, userTokenAccount: userTokenAccountAddress })
    .transaction();

  const latestBlockhash = await ctx.connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = ctx.wallet.publicKey;
  tx.sign(ctx.wallet.payer);

  const txSig = await ctx.connection.sendRawTransaction(tx.serialize());
  await ctx.connection.confirmTransaction(
    { signature: txSig, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
    'confirmed'
  );

  console.log('Subscribe confirmed:', txSig);

  return {
    network: ctx.network,
    txSig,
    signerWallet: ctx.wallet.publicKey.toBase58(),
    serviceLevelId,
    durationWeeks,
    selectedLeagues,
  };
}

export async function activateApiToken(input: ActivateInput) {
  const ctx = buildContext();
  const selectedLeagues = input.selectedLeagues ?? [];

  const messageString = `${input.txSig}:${selectedLeagues.join(',')}:${input.jwt}`;
  const message = new TextEncoder().encode(messageString);

  const signatureBytes = nacl.sign.detached(message, ctx.wallet.payer.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString('base64');

  const response = await axios.post(
    `${ctx.apiOrigin}/api/token/activate`,
    {
      txSig: input.txSig,
      walletSignature,
      leagues: selectedLeagues,
    },
    {
      headers: {
        Authorization: `Bearer ${input.jwt}`,
      },
    }
  );

  const apiToken = response.data?.token ?? response.data;

  if (!apiToken || typeof apiToken !== 'string') {
    throw new Error('Activation response did not include an API token');
  }

  return {
    network: ctx.network,
    txSig: input.txSig,
    signerWallet: ctx.wallet.publicKey.toBase58(),
    selectedLeagues,
    messageString,
    walletSignature,
    apiToken,
  };
}

export async function subscribeAndActivate(input: SubscribeInput = {}) {
  const guest = await requestGuestJwt();
  const subscribe = await subscribeOnChain(input);

  const activate = await activateApiToken({
    txSig: subscribe.txSig,
    jwt: guest.jwt,
    selectedLeagues: subscribe.selectedLeagues,
  });

  return {
    network: subscribe.network,
    jwt: guest.jwt,
    txSig: subscribe.txSig,
    apiToken: activate.apiToken,
    selectedLeagues: subscribe.selectedLeagues,
    signerWallet: subscribe.signerWallet,
  };
}

export async function verifyTradeOnChain(
  fixtureId: number,
  seq: number,
  outcome: string,
  participant1IsHome: boolean,
  isHomeWin: boolean
): Promise<boolean> {
  const ctx = buildContext();
  const guest = await requestGuestJwt();

  // 1. Fetch stat validation proof from the TxLINE API
  const res = await axios.get(`${ctx.apiOrigin}/api/scores/stat-validation`, {
    params: { fixtureId, seq, statKeys: '1,2' },
    headers: { Authorization: `Bearer ${guest.jwt}` }
  });
  const val = res.data;

  // 2. Map proof structure to Anchor-compatible format
  const mapProof = (proofArray: any[]): any[] => {
    return proofArray.map(n => ({
      hash: Array.from(n.hash),
      isRightSibling: n.isRightSibling,
    }));
  };

  const targetTs = val.summary.updateStats.minTimestamp;
  const epochDay = Math.floor(targetTs / (24 * 60 * 60 * 1000));

  const [dailyScoresPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), new anchor.BN(epochDay).toBuffer("le", 2)],
    ctx.programId
  );

  const payload = {
    ts: new anchor.BN(targetTs),
    fixtureSummary: {
      fixtureId: new anchor.BN(val.summary.fixtureId),
      updateStats: {
        updateCount: val.summary.updateStats.updateCount,
        minTimestamp: new anchor.BN(val.summary.updateStats.minTimestamp),
        maxTimestamp: new anchor.BN(val.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: Array.from(val.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(val.subTreeProof),
    mainTreeProof: mapProof(val.mainTreeProof),
    eventStatRoot: Array.from(val.eventStatRoot), 
    
    stats: val.statsToProve.map((statObj: any, index: number) => ({
      stat: statObj,
      statProof: mapProof(val.statProofs[index])
    }))
  };

  // 3. Translate outcome predicate to NDimensionalStrategy
  let strategy: any = null;

  if (outcome === 'Draw') {
    strategy = {
      geometricTargets: [],
      distancePredicate: null,
      discretePredicates: [
        {
          binary: {
            indexA: 0,
            indexB: 1,
            op: { subtract: {} },
            predicate: {
              threshold: 0,
              comparison: { equalTo: {} }
            }
          }
        }
      ]
    };
  } else if (outcome.endsWith('win')) {
    // If (isHomeWin && participant1IsHome) or (!isHomeWin && !participant1IsHome):
    //   Participant 1 won, index 0 is superior.
    // Else:
    //   Participant 2 won, index 1 is superior.
    const indexA = ((isHomeWin && participant1IsHome) || (!isHomeWin && !participant1IsHome)) ? 0 : 1;
    const indexB = indexA === 0 ? 1 : 0;

    strategy = {
      geometricTargets: [],
      distancePredicate: null,
      discretePredicates: [
        {
          binary: {
            indexA,
            indexB,
            op: { subtract: {} },
            predicate: {
              threshold: 0,
              comparison: { greaterThan: {} }
            }
          }
        }
      ]
    };
  } else if (outcome.startsWith('Over ') || outcome.startsWith('Under ')) {
    const line = parseFloat(outcome.split(' ')[1]);
    const isOver = outcome.startsWith('Over ');
    const threshold = isOver ? Math.floor(line) : Math.ceil(line);

    strategy = {
      geometricTargets: [],
      distancePredicate: null,
      discretePredicates: [
        {
          binary: {
            indexA: 0,
            indexB: 1,
            op: { add: {} },
            predicate: {
              threshold,
              comparison: isOver ? { greaterThan: {} } : { lessThan: {} }
            }
          }
        }
      ]
    };
  }

  if (!strategy) {
    throw new Error(`Unsupported outcome type for on-chain validation: ${outcome}`);
  }

  // 4. Build standard compute budget instruction to handle proof overhead
  const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');
  const computeBudgetIx = {
    keys: [],
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    data: Buffer.concat([
      Buffer.from([2]), // RequestUnits instruction
      new anchor.BN(1400000).toBuffer('le', 4), // units
      new anchor.BN(0).toBuffer('le', 4) // additional fee
    ])
  };

  // 5. Query read-only simulated check on Solana daily scores PDA
  const isValid = await ctx.program.methods
    .validateStatV2(payload, strategy)
    .accounts({
      dailyScoresMerkleRoots: dailyScoresPda,
    })
    .preInstructions([computeBudgetIx])
    .view();

  return !!isValid;
}
