import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

function expandHome(p: string) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(homedir(), p.slice(2));
  return p;
}
function resolvePath(p: string) {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(process.cwd(), e);
}

async function main() {
  const keypairPath = process.env.WALLET_KEYPAIR_PATH || '~/.config/solana/id.json';
  const fullPath = resolvePath(keypairPath);

  if (!existsSync(fullPath)) throw new Error('Wallet file not found: ' + fullPath);

  const secret = JSON.parse(readFileSync(fullPath, 'utf8')) as number[];
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));

  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const lamports = await connection.getBalance(kp.publicKey, 'confirmed');

  console.log(JSON.stringify({
    wallet: kp.publicKey.toBase58(),
    network: process.env.SOLANA_NETWORK ?? 'devnet',
    rpcUrl,
    balanceSol: lamports / LAMPORTS_PER_SOL,
    balanceLamports: lamports,
  }, null, 2));
}

main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
