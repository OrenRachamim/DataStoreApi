import { sha256Hex } from "./ids";

export type LogFields = Record<string, unknown>;

/**
 * Structured logs written explicitly from code. Platform invocation logs are
 * disabled in wrangler.jsonc because they record full URLs (DESIGN.md 12).
 * Never pass secrets, passwords, signatures, payment headers or content here.
 */
export function logEvent(kind: "request" | "payment" | "system", fields: LogFields): void {
  console.log(JSON.stringify({ kind, at: new Date().toISOString(), ...fields }));
}

/** IP hashed with a salt that rotates daily: enough to spot abuse, not to identify a person. */
export async function hashIp(ip: string | null | undefined, salt: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  return (await sha256Hex(`${salt}:${day}:${ip ?? ""}`)).slice(0, 24);
}
