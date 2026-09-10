import type { ContentKind } from "./content";

export interface PasswordHash {
  salt: string; // base64url
  hash: string; // hex
  iterations: number;
}

export interface LockState {
  failures: number;
  firstFailAt: string; // ISO
  lockedUntil?: string; // ISO
}

export interface Meta {
  id: string;
  secretHash: string;
  contentType: string;
  kind: ContentKind;
  size: number;
  label?: string;
  createdAt: string;
  expiresAt: string;
  readsRemaining: number;
  password?: PasswordHash;
  lock?: LockState;
  generation: number;
  /** Set once the upload payment settled. Absence means "paid for is pending". */
  tx?: string;
  payer?: string;
  lastPayment?: { type: "upload" | "extend" | "reads"; tx: string; payer: string; amount: string; at: string };
}

export interface IdemRecord {
  itemId: string;
  bodyHash: string;
  encryptedSecret: string;
  createdAt: string;
  /** Set as soon as the facilitator settled, before metadata is finalised. */
  tx?: string;
  amount?: string;
}

export const KEYS = {
  item: (id: string) => `items/${id}`,
  meta: (id: string) => `meta/${id}`,
  expiry: (date: string, id: string) => `expiry/${date}/${id}`,
  expiryPrefix: (date: string) => `expiry/${date}/`,
  idemNonce: (wallet: string, nonce: string) => `idem/${wallet.toLowerCase()}/n_${nonce.toLowerCase()}`,
  idemKey: (wallet: string, key: string) => `idem/${wallet.toLowerCase()}/k_${key}`,
  idemExpiry: (date: string, key: string) => `expiry/${date}/${key.replace(/\//g, "~")}`,
  feedback: (date: string, id: string) => `feedback/${date}/${id}`,
};

/** YYYY-MM-DD in UTC of an ISO timestamp. */
export function dateKey(iso: string): string {
  return iso.slice(0, 10);
}

export interface MetaWithEtag {
  meta: Meta;
  etag: string;
}

export async function readMeta(bucket: R2Bucket, id: string): Promise<MetaWithEtag | null> {
  const obj = await bucket.get(KEYS.meta(id));
  if (!obj) return null;
  const meta = (await obj.json()) as Meta;
  return { meta, etag: obj.etag };
}

/**
 * Write metadata. When `ifMatch` is given the write is conditional on the
 * current etag and returns false if someone else wrote first.
 */
export async function writeMeta(bucket: R2Bucket, meta: Meta, ifMatch?: string): Promise<boolean> {
  const body = JSON.stringify(meta);
  const res = await bucket.put(KEYS.meta(meta.id), body, {
    httpMetadata: { contentType: "application/json" },
    ...(ifMatch ? { onlyIf: { etagMatches: ifMatch } } : {}),
  });
  return res !== null;
}

/**
 * Read-modify-write with retries on etag conflict. `mutate` returns false to
 * abort without writing. Returns the final meta or null when aborted/missing.
 */
export async function updateMeta(
  bucket: R2Bucket,
  id: string,
  mutate: (meta: Meta) => boolean | void,
  attempts = 6,
): Promise<Meta | null> {
  for (let n = 0; n < attempts; n++) {
    const cur = await readMeta(bucket, id);
    if (!cur) return null;
    const draft: Meta = structuredClone(cur.meta);
    if (mutate(draft) === false) return null;
    if (await writeMeta(bucket, draft, cur.etag)) return draft;
  }
  throw new Error(`updateMeta: too many conflicts on ${id}`);
}

export async function putItemContent(bucket: R2Bucket, id: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await bucket.put(KEYS.item(id), bytes, { httpMetadata: { contentType } });
}

export async function getItemContent(bucket: R2Bucket, id: string): Promise<R2ObjectBody | null> {
  return bucket.get(KEYS.item(id));
}

export async function putExpiryMarker(bucket: R2Bucket, expiresAt: string, id: string): Promise<void> {
  await bucket.put(KEYS.expiry(dateKey(expiresAt), id), "");
}

export async function deleteExpiryMarker(bucket: R2Bucket, expiresAt: string, id: string): Promise<void> {
  await bucket.delete(KEYS.expiry(dateKey(expiresAt), id));
}

/** Remove an item completely: content, metadata and its expiry marker. */
export async function deleteItemCompletely(bucket: R2Bucket, id: string, expiresAt?: string): Promise<void> {
  const keys = [KEYS.item(id), KEYS.meta(id)];
  if (expiresAt) keys.push(KEYS.expiry(dateKey(expiresAt), id));
  await bucket.delete(keys);
}

export async function readIdem(bucket: R2Bucket, key: string): Promise<IdemRecord | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return (await obj.json()) as IdemRecord;
}

export async function writeIdem(bucket: R2Bucket, key: string, record: IdemRecord): Promise<void> {
  await bucket.put(key, JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
  // Idempotency records expire with the daily cron, 24 to 48 hours later.
  const tomorrow = new Date(Date.parse(record.createdAt) + 24 * 3600 * 1000).toISOString();
  await bucket.put(KEYS.idemExpiry(dateKey(tomorrow), key), "");
}

export async function deleteIdem(bucket: R2Bucket, key: string): Promise<void> {
  const rec = await readIdem(bucket, key);
  const keys = [key];
  if (rec) {
    const tomorrow = new Date(Date.parse(rec.createdAt) + 24 * 3600 * 1000).toISOString();
    keys.push(KEYS.idemExpiry(dateKey(tomorrow), key));
  }
  await bucket.delete(keys);
}
