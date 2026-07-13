import 'dotenv/config';

const keys = [
  'SOLANA_NETWORK',
  'SOLANA_RPC_URL',
  'TXLINE_API_ORIGIN',
  'TXLINE_PROGRAM_ID',
  'TXLINE_TXL_MINT',
  'TXLINE_IDL_PATH',
  'WALLET_KEYPAIR_PATH',
  'SERVICE_LEVEL_ID',
  'DURATION_WEEKS',
];

for (const key of keys) {
  const val = process.env[key];
  console.log(`${key}=${val ?? '(not set)'}`);
}
