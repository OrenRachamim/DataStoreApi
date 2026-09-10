/**
 * Per-key rate limits. Uses the Workers Rate Limiting binding when present and
 * an in-memory sliding counter otherwise (local dev and tests).
 */
export interface RateLimiterBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface LimitSpec {
  limit: number;
  periodSeconds: number;
}

import { testHooks } from "./hooks";

const memory = new Map<string, { count: number; windowStart: number }>();

export function resetLimitsForTests(): void {
  memory.clear();
}

export async function checkLimit(binding: RateLimiterBinding | undefined, name: string, key: string, spec: LimitSpec): Promise<boolean> {
  if (testHooks.forceRateLimit?.(name)) return false;
  if (binding) {
    const { success } = await binding.limit({ key: `${name}:${key}` });
    return success;
  }
  const now = Date.now();
  const k = `${name}:${key}`;
  const cur = memory.get(k);
  if (!cur || now - cur.windowStart >= spec.periodSeconds * 1000) {
    memory.set(k, { count: 1, windowStart: now });
    return true;
  }
  cur.count += 1;
  return cur.count <= spec.limit;
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}
