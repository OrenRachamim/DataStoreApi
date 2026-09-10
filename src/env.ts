export interface Env {
  BUCKET: R2Bucket;
  NETWORK: string;
  PAY_TO: string;
  FACILITATOR_URL: string;
  API_ORIGIN: string;
  DL_ORIGIN: string;
  MAX_BYTES: string;
  MAX_TTL_DAYS: string;
  DEFAULT_TTL_DAYS: string;
  SERVICE_NAME: string;
  HMAC_KEY: string;
  IDEM_KEY: string;
  IP_SALT: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  PASSWORD_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  API_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

export interface Config {
  network: string;
  isTestnet: boolean;
  payTo: string;
  facilitatorUrl: string;
  apiOrigin: string;
  dlOrigin: string;
  maxBytes: number;
  maxTtlDays: number;
  defaultTtlDays: number;
  serviceName: string;
  /** Price of every paid operation, in USD, as a decimal string. */
  priceUsd: string;
  includedReads: number;
  readPackSize: number;
  maxLabelLength: number;
  uploadTimeoutSeconds: number;
  otherTimeoutSeconds: number;
  hmacKey: string;
  idemKey: string;
  ipSalt: string;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function configFromEnv(env: Env): Config {
  const network = env.NETWORK || "eip155:84532";
  return {
    network,
    isTestnet: network !== "eip155:8453",
    payTo: env.PAY_TO,
    facilitatorUrl: env.FACILITATOR_URL || "https://x402.org/facilitator",
    apiOrigin: (env.API_ORIGIN || "http://localhost:8787").replace(/\/$/, ""),
    dlOrigin: (env.DL_ORIGIN || "http://localhost:8788").replace(/\/$/, ""),
    maxBytes: int(env.MAX_BYTES, 25 * 1024 * 1024),
    maxTtlDays: int(env.MAX_TTL_DAYS, 365),
    defaultTtlDays: int(env.DEFAULT_TTL_DAYS, 7),
    serviceName: env.SERVICE_NAME || "DataStore API",
    priceUsd: "0.01",
    includedReads: 100,
    readPackSize: 1000,
    maxLabelLength: 100,
    uploadTimeoutSeconds: 600,
    otherTimeoutSeconds: 60,
    hmacKey: env.HMAC_KEY,
    idemKey: env.IDEM_KEY,
    ipSalt: env.IP_SALT,
  };
}
