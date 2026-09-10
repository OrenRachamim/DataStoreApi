import type { Config } from "./env";
import type { Meta } from "./store";

export interface ItemObject {
  id: string;
  secret?: string;
  label?: string;
  content_type: string;
  size: number;
  created_at: string;
  expires_at: string;
  reads_remaining: number;
  has_password: boolean;
  links: Record<string, string>;
  payment?: { amount: string; currency: string; network: string; tx: string };
}

export function itemLinks(config: Config, id: string): Record<string, string> {
  const base = `${config.apiOrigin}/v1/items/${id}`;
  return {
    self: base,
    status: `${base}/status`,
    extend: `${base}/extend`,
    reads: `${base}/reads`,
    share: `${base}/links`,
    delete: base,
  };
}

export function itemObject(
  config: Config,
  meta: Meta,
  opts: { secret?: string; payment?: { tx: string; amount: string } } = {},
): ItemObject {
  const obj: ItemObject = {
    id: meta.id,
    ...(opts.secret ? { secret: opts.secret } : {}),
    ...(meta.label !== undefined ? { label: meta.label } : {}),
    content_type: meta.contentType,
    size: meta.size,
    created_at: meta.createdAt,
    expires_at: meta.expiresAt,
    reads_remaining: meta.readsRemaining,
    has_password: !!meta.password,
    links: itemLinks(config, meta.id),
  };
  if (opts.payment) {
    obj.payment = { amount: opts.payment.amount, currency: "USDC", network: networkName(config.network), tx: opts.payment.tx };
  }
  return obj;
}

export function networkName(network: string): string {
  if (network === "eip155:8453") return "base";
  if (network === "eip155:84532") return "base-sepolia";
  return network;
}

export function isExpired(meta: Meta, now = Date.now()): boolean {
  return Date.parse(meta.expiresAt) <= now;
}

export function addDays(fromMs: number, days: number): string {
  return new Date(fromMs + days * 86_400_000).toISOString();
}
