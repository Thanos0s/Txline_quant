import 'dotenv/config';
import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { getEnv, resolveNetworkDefaults } from './config';

type Credentials = {
  jwt: string;
  apiToken: string;
  apiOrigin: string;
};

const env = getEnv();
const defaults = resolveNetworkDefaults(env.SOLANA_NETWORK);
const apiOrigin = env.TXLINE_API_ORIGIN ?? defaults.apiOrigin;

let credentials: Credentials = {
  jwt: env.TXLINE_GUEST_JWT ?? '',
  apiToken: env.TXLINE_API_TOKEN ?? '',
  apiOrigin,
};

export function getCredentials(): Credentials {
  return { ...credentials };
}

export function credentialStatus(): { hasJwt: boolean; hasApiToken: boolean; apiOrigin: string } {
  return {
    hasJwt: !!credentials.jwt,
    hasApiToken: !!credentials.apiToken,
    apiOrigin: credentials.apiOrigin,
  };
}

export async function renewJwt(): Promise<string> {
  console.log('[auth] Fetching guest JWT...');
  const res = await axios.post<{ token: string }>(`${apiOrigin}/auth/guest/start`);
  credentials.jwt = res.data.token;
  console.log('[auth] JWT ready.');
  return credentials.jwt;
}

/** Ensure a guest JWT exists; fetches one automatically if missing. */
let jwtInit: Promise<string> | null = null;
export async function ensureJwt(): Promise<void> {
  if (credentials.jwt) return;
  if (!jwtInit) jwtInit = renewJwt().finally(() => { jwtInit = null; });
  await jwtInit;
}

export const apiClient: AxiosInstance = axios.create({
  baseURL: `${apiOrigin}/api`,
});

// Inject auth headers on every request; auto-fetch JWT if missing
apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  await ensureJwt();
  if (credentials.jwt)     config.headers['Authorization'] = `Bearer ${credentials.jwt}`;
  if (credentials.apiToken) config.headers['X-Api-Token']  = credentials.apiToken;
  return config;
});

const NETWORK_ERRORS = new Set(['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN']);

// On 401: renew JWT and retry once. On network errors: retry up to 3 times.
let refreshing: Promise<string> | null = null;
apiClient.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean; _retryCount?: number };

    // 401 → renew JWT, retry once
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      if (!refreshing) refreshing = renewJwt().finally(() => { refreshing = null; });
      const newJwt = await refreshing;
      original.headers['Authorization'] = `Bearer ${newJwt}`;
      return apiClient(original);
    }

    // Network errors → retry up to 3 times with backoff
    const code = (error as AxiosError & { code?: string }).code ?? '';
    if (!error.response && NETWORK_ERRORS.has(code)) {
      original._retryCount = (original._retryCount ?? 0) + 1;
      if (original._retryCount <= 3) {
        console.warn(`[api-client] ${code} – retrying (${original._retryCount}/3)...`);
        await new Promise(r => setTimeout(r, 500 * original._retryCount!));
        return apiClient(original);
      }
    }

    return Promise.reject(error);
  }
);
