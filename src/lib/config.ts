import { z } from 'zod';

const envSchema = z.object({
  SOLANA_NETWORK: z.enum(['devnet', 'mainnet', 'mainnet-beta']).default('devnet'),
  SOLANA_RPC_URL: z.string().url().optional(),
  TXLINE_API_ORIGIN: z.string().url().optional(),
  TXLINE_PROGRAM_ID: z.string().min(1).optional(),
  TXLINE_TXL_MINT: z.string().min(1).optional(),
  TXLINE_IDL_PATH: z.string().min(1).optional(),
  WALLET_KEYPAIR_PATH: z.string().min(1).optional(),
  SOLANA_WALLET_SECRET_KEY: z.string().min(1).optional(),
  SERVICE_LEVEL_ID: z.coerce.number().int().positive().default(1),
  DURATION_WEEKS: z.coerce.number().int().positive().default(4),
  SELECTED_LEAGUES: z.string().optional(),
  TXLINE_GUEST_JWT: z.string().optional(),
  TXLINE_API_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
export type AppNetwork = Env['SOLANA_NETWORK'];

type NetworkDefaults = {
  rpcUrl: string;
  apiOrigin: string;
  programId: string;
  txlTokenMint: string;
};

const NETWORK_DEFAULTS: Record<'devnet' | 'mainnet-beta', NetworkDefaults> = {
  devnet: {
    rpcUrl: 'https://api.devnet.solana.com',
    apiOrigin: 'https://txline-dev.txodds.com',
    programId: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
    txlTokenMint: '4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG',
  },
  'mainnet-beta': {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    apiOrigin: 'https://txline.txodds.com',
    programId: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
    txlTokenMint: 'Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL',
  },
};

function normalizeNetwork(network: AppNetwork): 'devnet' | 'mainnet-beta' {
  return network === 'mainnet' ? 'mainnet-beta' : network;
}

export function resolveNetworkDefaults(network: AppNetwork): NetworkDefaults {
  return NETWORK_DEFAULTS[normalizeNetwork(network)];
}

export function getEnv(raw = process.env): Env {
  return envSchema.parse(raw);
}
