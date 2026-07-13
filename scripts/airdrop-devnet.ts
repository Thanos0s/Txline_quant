import 'dotenv/config';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

function expandHome(pathValue: string): string {
  if (pathValue === '~') return homedir();
  if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) {
    return resolve(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function resolvePath(pathValue: string): string {
  const expanded = expandHome(pathValue);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

async function airdropViaSolanaFaucet(pubkey: string, sol: number): Promise<string> {
  const res = await fetch('https://faucet.solana.com/api/airdrop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: pubkey, amount: sol * LAMPORTS_PER_SOL }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`faucet.solana.com ${res.status}: ${text}`);
  }

  const data = await res.json() as { signature?: string; txid?: string };
  const sig = data.signature ?? data.txid;
  if (!sig) throw new Error('Faucet did not return a signature: ' + JSON.stringify(data));
  return sig;
}

async function main() {
  const keypairPath = process.env.WALLET_KEYPAIR_PATH || '~/.config/solana/id.json';
  const fullPath = resolvePath(keypairPath);

  let kp: Keypair;

  if (!existsSync(fullPath)) {
    mkdirSync(dirname(fullPath), { recursive: true });
    kp = Keypair.generate();
    writeFileSync(fullPath, JSON.stringify(Array.from(kp.secretKey)));
    console.log('Created new wallet keypair at: ' + fullPath);
  } else {
    const secret = JSON.parse(readFileSync(fullPath, 'utf8')) as number[];
    kp = Keypair.fromSecretKey(Uint8Array.from(secret));
    console.log('Loaded existing wallet: ' + fullPath);
  }

  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const beforeLamports = await connection.getBalance(kp.publicKey, 'confirmed');
  console.log(`Wallet:     ${kp.publicKey.toBase58()}`);
  console.log(`Balance before: ${(beforeLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log('Requesting airdrop via faucet.solana.com ...');

  let sig = '';
  let lastError = '';

  for (const sol of [2, 1, 0.5]) {
    try {
      sig = await airdropViaSolanaFaucet(kp.publicKey.toBase58(), sol);
      console.log(`Airdrop tx sent (${sol} SOL): ${sig}`);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.log(`Attempt ${sol} SOL failed: ${lastError}`);
    }
  }

  if (!sig) {
    throw new Error('All airdrop attempts failed. Fund manually at https://faucet.solana.com');
  }

  console.log('Confirming transaction ...');
  await connection.confirmTransaction(sig, 'confirmed');

  const afterLamports = await connection.getBalance(kp.publicKey, 'confirmed');

  console.log(
    JSON.stringify(
      {
        wallet: kp.publicKey.toBase58(),
        airdropSignature: sig,
        beforeSol: beforeLamports / LAMPORTS_PER_SOL,
        afterSol: afterLamports / LAMPORTS_PER_SOL,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
