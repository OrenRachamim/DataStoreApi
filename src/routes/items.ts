import type { Context, Hono } from "hono";
import type { AppContext } from "../app";
import { detectContent, normalizeDeclaredType, UnsupportedContent, ALLOWED_TYPES } from "../content";
import { ApiError, notFound } from "../errors";
import { decryptString, encryptString, ITEM_ID_RE, newItemId, newSecret, sha256Hex, timingSafeEqual } from "../ids";
import { addDays, isExpired, itemObject } from "../items";
import { paidMetaOperation } from "./paid";
import { deleteExpiryMarker } from "../store";
import { logEvent } from "../log";
import { testHooks } from "../hooks";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER, PaymentError, type ParsedPayment } from "../payment";
import type { PaymentRequirements } from "@x402/core/types";
import {
  deleteIdem,
  deleteItemCompletely,
  KEYS,
  putExpiryMarker,
  putItemContent,
  getItemContent,
  readIdem,
  readMeta,
  updateMeta,
  writeIdem,
  writeMeta,
  type Meta,
  type MetaWithEtag,
} from "../store";

type Ctx = Context<AppContext>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function bearerSecret(c: Ctx): string | undefined {
  const h = c.req.header("authorization");
  if (!h) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1];
}

/** Load an item the caller owns. Any failure is the one uniform 404. */
export async function loadOwnedItem(c: Ctx, id: string): Promise<MetaWithEtag> {
  const secret = bearerSecret(c);
  if (!secret || !ITEM_ID_RE.test(id)) throw notFound();
  const cur = await readMeta(c.env.BUCKET, id);
  if (!cur) throw notFound();
  const hash = await sha256Hex(secret);
  if (!timingSafeEqual(hash, cur.meta.secretHash)) throw notFound();
  if (isExpired(cur.meta)) throw notFound();
  c.get("logFields").item_id = id;
  return cur;
}

export function parseTtlDays(raw: string | undefined, c: Ctx): number {
  const cfg = c.get("config");
  if (raw === undefined || raw === "") return cfg.defaultTtlDays;
  if (!/^\d+$/.test(raw)) throw invalid(`ttl_days must be an integer between 1 and ${cfg.maxTtlDays}.`, { ttl_days: raw });
  const n = Number.parseInt(raw, 10);
  if (n < 1 || n > cfg.maxTtlDays) throw invalid(`ttl_days must be between 1 and ${cfg.maxTtlDays}.`, { ttl_days: raw });
  return n;
}

export function invalid(message: string, extra?: Record<string, unknown>): ApiError {
  return new ApiError(400, "invalid_request", message, { description: "Fix the parameter and retry. No charge was made." }, extra);
}

/** Read a request body fully, capped. Never trusts Content-Length. */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ApiError(413, "too_large", `Body exceeds the ${maxBytes} byte limit.`, {
        description: "Split or compress the content before uploading. No charge was made.",
      });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

export interface PaidContext {
  parsed: ParsedPayment;
  matched: PaymentRequirements;
}

/**
 * Enforce x402 on a route. Without a payment header this throws the 402 that
 * x402 clients understand. With one, it decodes and matches the payment but
 * does not verify or settle yet.
 */
export async function requirePayment(
  c: Ctx,
  opts: { description: string; timeoutSeconds: number; code?: "payment_required" | "reads_exhausted"; message?: string; action?: { description: string; method?: string; url?: string } },
): Promise<PaidContext> {
  const payments = c.get("payments");
  const cfg = c.get("config");
  const resourceUrl = new URL(c.req.url);
  resourceUrl.protocol = new URL(cfg.apiOrigin).protocol;
  resourceUrl.host = new URL(cfg.apiOrigin).host;
  const url = resourceUrl.toString();
  const header = c.req.header(PAYMENT_SIGNATURE_HEADER);

  const paymentRequired = async (error?: string, code?: "payment_required" | "reads_exhausted", message?: string) => {
    const pr = await payments.paymentRequired(url, opts.description, opts.timeoutSeconds, error);
    const action = opts.action ?? {
      description: `Pay $${cfg.priceUsd} USDC on ${cfg.network} with an x402 client and retry this request.${cfg.isTestnet ? " Testnet USDC: https://faucet.circle.com" : ""}`,
      method: c.req.method,
      url,
    };
    return new ApiError(
      402,
      code ?? opts.code ?? "payment_required",
      message ?? opts.message ?? `Payment of $${cfg.priceUsd} USDC is required for this operation.`,
      action,
      { x402: pr.body, terms: `${cfg.apiOrigin}/terms` },
      { [PAYMENT_REQUIRED_HEADER]: pr.header, "Cache-Control": "no-store" },
    );
  };

  if (!header) throw await paymentRequired();
  const reqs = await payments.requirements(url, opts.timeoutSeconds);
  try {
    return await payments.parse(header, reqs);
  } catch (err) {
    if (err instanceof PaymentError) throw await paymentRequired(err.reason, "payment_required", err.message);
    throw err;
  }
}

export async function verifyOr402(c: Ctx, paid: PaidContext, description: string, timeoutSeconds: number): Promise<void> {
  try {
    await c.get("payments").verify(paid.parsed, paid.matched);
  } catch (err) {
    if (err instanceof PaymentError) {
      const pr = await c.get("payments").paymentRequired(paid.matched.extra ? new URL(c.req.url).toString() : c.req.url, description, timeoutSeconds, err.reason);
      throw new ApiError(402, "payment_required", `Payment could not be verified: ${err.message}`, { description: "Check the wallet balance and sign a fresh payment, then retry.", method: c.req.method, url: c.req.url }, { x402: pr.body }, { [PAYMENT_REQUIRED_HEADER]: pr.header });
    }
    throw err;
  }
}

function auditPayment(c: Ctx, fields: Record<string, unknown>): void {
  logEvent("payment", { request_id: c.get("requestId"), network: c.get("config").network, ...fields });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function itemRoutes(app: Hono<AppContext>): void {
  app.post("/v1/items", uploadHandler);
  app.get("/v1/items/:id", retrieveHandler);
  app.get("/v1/items/:id/status", statusHandler);
  app.delete("/v1/items/:id", deleteHandler);
  app.post("/v1/items/:id/extend", extendHandler);
  app.post("/v1/items/:id/reads", readsHandler);
}

async function uploadHandler(c: Ctx): Promise<Response> {
  const cfg = c.get("config");
  const bucket = c.env.BUCKET;
  const payments = c.get("payments");

  // 1. Cheap validation first, so an agent learns about a bad parameter before paying.
  const ttlDays = parseTtlDays(c.req.query("ttl_days"), c);
  const labelRaw = c.req.query("label");
  const label = labelRaw === undefined ? undefined : labelRaw.trim();
  if (label !== undefined && label.length > cfg.maxLabelLength) throw invalid(`label must be at most ${cfg.maxLabelLength} characters.`);

  // 2. Payment header present and well-formed, else 402.
  const paid = await requirePayment(c, { description: `Store an item for ${ttlDays} days`, timeoutSeconds: cfg.uploadTimeoutSeconds });
  const { parsed, matched } = paid;
  const nonceKey = KEYS.idemNonce(parsed.payer, parsed.nonce);
  const idemHeader = c.req.header("idempotency-key");
  const keyKey = idemHeader ? KEYS.idemKey(parsed.payer, await sha256Hex(idemHeader)) : undefined;

  // 3. Same signature seen before: return or resume, never settle twice.
  let existing = await readIdem(bucket, nonceKey);
  let existingKey = nonceKey;
  if (!existing && keyKey) {
    existing = await readIdem(bucket, keyKey);
    existingKey = keyKey;
  }
  if (existing) {
    let cur = await readMeta(bucket, existing.itemId);
    if (cur && !cur.meta.tx && existing.tx) {
      // Settled, but the previous attempt died before finalising the metadata.
      await finalizeUpload(bucket, existing.itemId, existing.tx, parsed.payer, existing.amount ?? matched.amount);
      cur = await readMeta(bucket, existing.itemId);
    }
    if (cur?.meta.tx) {
      // Completed earlier; only the body hash matters for the explicit key case.
      if (existingKey === keyKey) {
        const bytes = await readBodyCapped(c.req.raw, cfg.maxBytes);
        if ((await sha256Hex(bytes)) !== existing.bodyHash) throw idemConflict();
      }
      const secret = await decryptString(cfg.idemKey, existing.encryptedSecret);
      c.get("logFields").idempotent_replay = true;
      return respondStored(c, cur.meta, secret, { tx: cur.meta.tx, amount: cur.meta.lastPayment?.amount ?? matched.amount });
    }
  }

  // 4. Verify with the facilitator (free) before touching the body.
  try {
    await verifyOr402(c, paid, "Store an item", cfg.uploadTimeoutSeconds);
  } catch (err) {
    // A nonce the chain already consumed, on an attempt we started ourselves,
    // means the money moved but we lost the receipt. Never charge twice: finish
    // the item and flag it for reconciliation.
    if (existing && err instanceof ApiError && /nonce_already_used/.test(String((err.extra?.x402 as { error?: string } | undefined)?.error ?? ""))) {
      const cur = await readMeta(bucket, existing.itemId);
      if (cur && !cur.meta.tx) {
        const paidMeta = await finalizeUpload(bucket, existing.itemId, "unknown", parsed.payer, matched.amount);
        auditPayment(c, { op: "upload", item_id: existing.itemId, payer: parsed.payer, amount: matched.amount, tx: "unknown", result: "settled_receipt_lost" });
        logEvent("system", { event: "settlement_receipt_lost", item_id: existing.itemId, payer: parsed.payer });
        const secret = await decryptString(cfg.idemKey, existing.encryptedSecret);
        return respondStored(c, paidMeta ?? cur.meta, secret, { tx: "unknown", amount: matched.amount });
      }
    }
    throw err;
  }

  // 5. Body and content validation. Failures here never settle.
  const bytes = await readBodyCapped(c.req.raw, cfg.maxBytes);
  if (bytes.byteLength === 0) throw invalid("Body is empty.");
  let detected;
  try {
    detected = detectContent(bytes, normalizeDeclaredType(c.req.header("content-type")));
  } catch (err) {
    if (err instanceof UnsupportedContent) {
      throw new ApiError(415, "unsupported_type", err.message, { description: "Upload one of the allowed content types. No charge was made." }, { allowed_content_types: [...ALLOWED_TYPES] });
    }
    throw err;
  }
  const bodyHash = await sha256Hex(bytes);
  if (existing && existingKey === keyKey && existing.bodyHash !== bodyHash) throw idemConflict();

  // 6. Identity of the item: reuse from an unfinished attempt or mint new.
  let id: string;
  let secret: string;
  if (existing) {
    id = existing.itemId;
    secret = await decryptString(cfg.idemKey, existing.encryptedSecret);
  } else {
    id = newItemId();
    secret = newSecret();
    const record = { itemId: id, bodyHash, encryptedSecret: await encryptString(cfg.idemKey, secret), createdAt: new Date().toISOString() };
    await writeIdem(bucket, nonceKey, record);
    if (keyKey) await writeIdem(bucket, keyKey, record);
  }

  // 7. Store content and metadata, then settle.
  const now = Date.now();
  const meta: Meta = {
    id,
    secretHash: await sha256Hex(secret),
    contentType: detected.contentType,
    kind: detected.kind,
    size: bytes.byteLength,
    ...(label ? { label } : {}),
    createdAt: new Date(now).toISOString(),
    expiresAt: addDays(now, ttlDays),
    readsRemaining: cfg.includedReads,
    generation: 1,
  };
  await testHooks.beforeStore?.(id);
  await putItemContent(bucket, id, bytes, detected.contentType);
  await writeMeta(bucket, meta);
  await putExpiryMarker(bucket, meta.expiresAt, id);
  c.get("logFields").item_id = id;
  c.get("logFields").size = bytes.byteLength;

  await testHooks.beforeSettle?.(id);
  let settle;
  try {
    settle = await payments.settle(parsed, matched);
  } catch (err) {
    const reason = err instanceof PaymentError ? err.reason : "settlement_error";
    const message = err instanceof PaymentError ? err.message : String((err as Error)?.message ?? err);
    // A concurrent identical retry may have settled first. Never delete a paid item.
    const latest = await readMeta(bucket, id);
    if (latest?.meta.tx) {
      return respondStored(c, latest.meta, secret, { tx: latest.meta.tx, amount: latest.meta.lastPayment?.amount ?? matched.amount });
    }
    await deleteItemCompletely(bucket, id, meta.expiresAt);
    await deleteIdem(bucket, nonceKey);
    if (keyKey) await deleteIdem(bucket, keyKey);
    auditPayment(c, { op: "upload", item_id: id, payer: parsed.payer, amount: matched.amount, result: "settle_failed_cleaned", reason });
    logEvent("system", { event: "settle_failed_cleaned", item_id: id, reason });
    const pr = await payments.paymentRequired(c.req.url, "Store an item", cfg.uploadTimeoutSeconds, reason);
    throw new ApiError(402, "payment_required", `Payment settlement failed: ${message}. Nothing was stored.`, { description: "Sign a fresh payment and upload again.", method: "POST", url: c.req.url }, { x402: pr.body }, { [PAYMENT_REQUIRED_HEADER]: pr.header });
  }

  // Money moved. Record the tx where a retry will find it, then log, then finalise.
  auditPayment(c, { op: "upload", item_id: id, payer: parsed.payer, amount: matched.amount, tx: settle.transaction, result: "settled", ttl_days: ttlDays, size: bytes.byteLength });
  await markIdemSettled(bucket, [nonceKey, keyKey], settle.transaction, matched.amount);
  await testHooks.afterSettle?.(id);
  const paidMeta = await finalizeUpload(bucket, id, settle.transaction, parsed.payer, matched.amount);
  c.header(PAYMENT_RESPONSE_HEADER, payments.responseHeader(settle));
  return respondStored(c, paidMeta ?? meta, secret, { tx: settle.transaction, amount: matched.amount });
}

async function markIdemSettled(bucket: R2Bucket, keys: Array<string | undefined>, tx: string, amount: string): Promise<void> {
  for (const key of keys) {
    if (!key) continue;
    const rec = await readIdem(bucket, key);
    if (rec && !rec.tx) await writeIdem(bucket, key, { ...rec, tx, amount });
  }
}

async function finalizeUpload(bucket: R2Bucket, id: string, tx: string, payer: string, amount: string): Promise<Meta | null> {
  return updateMeta(bucket, id, (m) => {
    if (m.tx) return false;
    m.tx = tx;
    m.payer = payer;
    m.lastPayment = { type: "upload", tx, payer, amount, at: new Date().toISOString() };
  });
}

function idemConflict(): ApiError {
  return new ApiError(409, "idempotency_conflict", "This Idempotency-Key was already used with a different body.", {
    description: "Use a new Idempotency-Key for new content. No charge was made.",
  });
}

function respondStored(c: Ctx, meta: Meta, secret: string, payment: { tx: string; amount: string }): Response {
  const cfg = c.get("config");
  const body = itemObject(cfg, meta, { secret, payment: { tx: payment.tx, amount: formatUsdc(payment.amount) } });
  return c.json(body, 201);
}

export function formatUsdc(atomic: string): string {
  const n = BigInt(atomic);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

async function retrieveHandler(c: Ctx): Promise<Response> {
  const cfg = c.get("config");
  const bucket = c.env.BUCKET;
  const id = c.req.param("id") as string;
  const cur = await loadOwnedItem(c, id);
  const meta = cur.meta;
  c.get("logFields").access = "secret";

  let servedMeta = meta;
  let paymentResponseHeader: string | undefined;
  if (meta.readsRemaining <= 0) {
    // Pay-on-read: an x402 client pays on this same request, gets a read pack
    // applied and the content in one round. Without payment: an x402 402.
    const url = `${cfg.apiOrigin}/v1/items/${id}`;
    const action = { description: `Pay $${cfg.priceUsd} USDC on this request, or buy ${cfg.readPackSize} reads in advance at the reads URL, then retry.`, method: "POST", url: `${url}/reads` };
    if (!c.req.header(PAYMENT_SIGNATURE_HEADER)) {
      try {
        await requirePayment(c, { description: `Add ${cfg.readPackSize} reads to item ${id}`, timeoutSeconds: cfg.otherTimeoutSeconds, code: "reads_exhausted", message: "This item has no reads left.", action });
      } catch (err) {
        if (err instanceof ApiError) throw new ApiError(err.status, err.code, err.message, err.action, { ...err.extra, expires_at: meta.expiresAt }, err.headers);
        throw err;
      }
    }
    const result = await paidMetaOperation(c, {
      itemId: id,
      op: "reads",
      description: `Add ${cfg.readPackSize} reads to item ${id}`,
      apply: (m) => {
        m.readsRemaining += cfg.readPackSize;
      },
    });
    servedMeta = result.meta;
    paymentResponseHeader = result.paymentResponseHeader;
    c.get("logFields").paid_read = true;
  }
  const obj = await getItemContent(bucket, id);
  if (!obj) throw notFound();

  c.executionCtx.waitUntil(
    updateMeta(bucket, id, (m) => {
      if (m.readsRemaining <= 0) return false;
      m.readsRemaining -= 1;
    }).catch((err) => logEvent("system", { event: "read_counter_failed", item_id: id, error: String(err?.message ?? err) })),
  );

  const headers = new Headers();
  headers.set("Content-Type", meta.contentType);
  headers.set("Content-Length", String(meta.size));
  headers.set("X-Reads-Remaining", String(servedMeta.readsRemaining - 1));
  headers.set("X-Expires-At", servedMeta.expiresAt);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  if (meta.kind === "binary" || meta.kind === "text") {
    headers.set("Content-Disposition", `attachment; filename="${id}${extensionFor(meta.contentType)}"`);
  } else if (meta.kind === "html" || meta.kind === "svg") {
    headers.set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups");
  }
  if (paymentResponseHeader) headers.set(PAYMENT_RESPONSE_HEADER, paymentResponseHeader);
  return new Response(obj.body, { status: 200, headers });
}

export function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    "application/json": ".json",
    "text/html": ".html",
    "image/svg+xml": ".svg",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return map[contentType] ?? "";
}

async function extendHandler(c: Ctx): Promise<Response> {
  const cfg = c.get("config");
  const cur = await loadOwnedItem(c, c.req.param("id") as string);
  let body: { ttl_days?: unknown };
  try {
    body = (await c.req.json()) as { ttl_days?: unknown };
  } catch {
    throw invalid("Body must be JSON like {\"ttl_days\": 30}.");
  }
  const raw = body?.ttl_days;
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw invalid(`ttl_days must be an integer between 1 and ${cfg.maxTtlDays}.`, { ttl_days: raw });
  const ttlDays = parseTtlDays(String(raw), c);
  const now = Date.now();
  const newExpiry = addDays(now, ttlDays);
  if (Date.parse(newExpiry) <= Date.parse(cur.meta.expiresAt)) {
    throw invalid(`The new expiry ${newExpiry} is not later than the current expiry. Nothing was charged.`, { expires_at: cur.meta.expiresAt, requested_expires_at: newExpiry });
  }
  const oldExpiry = cur.meta.expiresAt;
  const result = await paidMetaOperation(c, {
    itemId: cur.meta.id,
    op: "extend",
    description: `Extend item ${cur.meta.id} to ${newExpiry}`,
    apply: (m) => {
      if (Date.parse(newExpiry) > Date.parse(m.expiresAt)) m.expiresAt = newExpiry;
    },
    after: async (m) => {
      await putExpiryMarker(c.env.BUCKET, m.expiresAt, m.id);
      if (m.expiresAt !== oldExpiry) await deleteExpiryMarker(c.env.BUCKET, oldExpiry, m.id);
    },
  });
  return c.json(itemObject(cfg, result.meta, { payment: { tx: result.tx, amount: formatUsdc(result.amount) } }));
}

async function readsHandler(c: Ctx): Promise<Response> {
  const cfg = c.get("config");
  const id = c.req.param("id") as string;
  if (!ITEM_ID_RE.test(id)) throw notFound();
  const cur = await readMeta(c.env.BUCKET, id);
  if (!cur || isExpired(cur.meta)) throw notFound();
  c.get("logFields").item_id = id;
  const result = await paidMetaOperation(c, {
    itemId: id,
    op: "reads",
    description: `Add ${cfg.readPackSize} reads to item ${id}`,
    apply: (m) => {
      m.readsRemaining += cfg.readPackSize;
    },
  });
  return c.json(itemObject(cfg, result.meta, { payment: { tx: result.tx, amount: formatUsdc(result.amount) } }));
}

async function statusHandler(c: Ctx): Promise<Response> {
  const cur = await loadOwnedItem(c, c.req.param("id") as string);
  return c.json(itemObject(c.get("config"), cur.meta));
}

async function deleteHandler(c: Ctx): Promise<Response> {
  const cur = await loadOwnedItem(c, c.req.param("id") as string);
  await deleteItemCompletely(c.env.BUCKET, cur.meta.id, cur.meta.expiresAt);
  logEvent("system", { event: "item_deleted_by_owner", item_id: cur.meta.id });
  return c.body(null, 204);
}
