import { base64url, hex, randomBytes, timingSafeEqual } from "./ids";
import type { PasswordHash } from "./store";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
/**
 * PBKDF2-SHA256 through WebCrypto. Argon2 is memory-bound and slow in Workers.
 * Cloudflare Workers cap PBKDF2 at 100,000 iterations (a higher count fails at runtime
 * with a 500; the local workerd used by the tests does not enforce the cap). Verification
 * uses the count stored with each hash, so older hashes keep verifying.
 */
export const PBKDF2_ITERATIONS = 100_000;

const enc = new TextEncoder();

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return hex(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  return { salt: base64url(salt), hash: await derive(password, salt, PBKDF2_ITERATIONS), iterations: PBKDF2_ITERATIONS };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const { fromBase64url } = await import("./ids");
  const computed = await derive(password, fromBase64url(stored.salt), stored.iterations);
  return timingSafeEqual(computed, stored.hash);
}
