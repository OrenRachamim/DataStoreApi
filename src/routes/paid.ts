import type { Context } from "hono";
import type { AppContext } from "../app";
import { ApiError } from "../errors";
import { logEvent } from "../log";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PaymentError } from "../payment";
import { deleteIdem, KEYS, readIdem, updateMeta, writeIdem, type Meta } from "../store";
import { requirePayment, verifyOr402 } from "./items";

type Ctx = Context<AppContext>;

export interface PaidMetaOp {
  itemId: string;
  op: "extend" | "reads";
  description: string;
  /** Mutates metadata once the payment is settled. Must be safe to call once per tx. */
  apply: (meta: Meta) => void;
  /** Runs after the metadata was updated (e.g. expiry markers). */
  after?: (meta: Meta) => Promise<void>;
}

export interface PaidMetaResult {
  meta: Meta;
  tx: string;
  amount: string;
  /** True when the settlement had been applied by an earlier attempt. */
  replay: boolean;
  /** Encoded PAYMENT-RESPONSE header when a settlement happened in this request. */
  paymentResponseHeader?: string;
}

/**
 * A paid operation that only changes metadata. Order: verify → settle → apply,
 * because the small update can be retried until it succeeds while a settlement
 * cannot be undone (DESIGN.md 5). Idempotent by payment nonce.
 */
export async function paidMetaOperation(c: Ctx, spec: PaidMetaOp): Promise<PaidMetaResult> {
  const cfg = c.get("config");
  const bucket = c.env.BUCKET;
  const payments = c.get("payments");
  const paid = await requirePayment(c, { description: spec.description, timeoutSeconds: cfg.otherTimeoutSeconds });
  const { parsed, matched } = paid;
  const key = KEYS.idemNonce(parsed.payer, parsed.nonce);

  const applyTx = async (tx: string): Promise<{ meta: Meta; replay: boolean }> => {
    let replay = false;
    const meta = await updateMeta(bucket, spec.itemId, (m) => {
      if (m.appliedTx?.includes(tx)) {
        replay = true;
        return false;
      }
      spec.apply(m);
      m.appliedTx = [...(m.appliedTx ?? []).slice(-49), tx];
      m.lastPayment = { type: spec.op, tx, payer: parsed.payer, amount: matched.amount, at: new Date().toISOString() };
    });
    if (!meta) {
      const cur = await import("../store").then((s) => s.readMeta(bucket, spec.itemId));
      if (!cur) throw new ApiError(404, "not_found", "Item not available.", { description: "The item disappeared before the payment could be applied. Contact feedback with the request id." });
      return { meta: cur.meta, replay: true };
    }
    if (spec.after) await spec.after(meta);
    return { meta, replay };
  };

  // Same signature as an earlier attempt.
  const existing = await readIdem(bucket, key);
  if (existing?.tx && existing.itemId === spec.itemId) {
    const { meta, replay } = await applyTx(existing.tx);
    c.get("logFields").idempotent_replay = true;
    return { meta, tx: existing.tx, amount: existing.amount ?? matched.amount, replay };
  }

  try {
    await verifyOr402(c, paid, spec.description, cfg.otherTimeoutSeconds);
  } catch (err) {
    if (existing && err instanceof ApiError && /nonce_already_used/.test(String((err.extra?.x402 as { error?: string } | undefined)?.error ?? ""))) {
      // We started this settlement and the chain consumed the nonce: paid, receipt lost.
      const { meta, replay } = await applyTx(`unknown:${parsed.nonce}`);
      logEvent("system", { event: "settlement_receipt_lost", item_id: spec.itemId, op: spec.op, payer: parsed.payer });
      audit(c, { op: spec.op, item_id: spec.itemId, payer: parsed.payer, amount: matched.amount, tx: "unknown", result: "settled_receipt_lost" });
      return { meta, tx: "unknown", amount: matched.amount, replay };
    }
    throw err;
  }

  if (!existing) {
    await writeIdem(bucket, key, { itemId: spec.itemId, bodyHash: "", encryptedSecret: "", createdAt: new Date().toISOString(), op: spec.op });
  }

  let settle;
  try {
    settle = await payments.settle(parsed, matched);
  } catch (err) {
    const reason = err instanceof PaymentError ? err.reason : "settlement_error";
    const message = err instanceof PaymentError ? err.message : String((err as Error)?.message ?? err);
    await deleteIdem(bucket, key);
    audit(c, { op: spec.op, item_id: spec.itemId, payer: parsed.payer, amount: matched.amount, result: "settle_failed", reason });
    const pr = await payments.paymentRequired(c.req.url, spec.description, cfg.otherTimeoutSeconds, reason);
    throw new ApiError(402, "payment_required", `Payment settlement failed: ${message}. Nothing was changed.`, { description: "Sign a fresh payment and retry.", method: c.req.method, url: c.req.url }, { x402: pr.body }, { [PAYMENT_REQUIRED_HEADER]: pr.header });
  }

  audit(c, { op: spec.op, item_id: spec.itemId, payer: parsed.payer, amount: matched.amount, tx: settle.transaction, result: "settled" });
  const rec = await readIdem(bucket, key);
  if (rec) await writeIdem(bucket, key, { ...rec, tx: settle.transaction, amount: matched.amount });
  const { meta, replay } = await applyTx(settle.transaction);
  const paymentResponseHeader = payments.responseHeader(settle);
  c.header(PAYMENT_RESPONSE_HEADER, paymentResponseHeader);
  return { meta, tx: settle.transaction, amount: matched.amount, replay, paymentResponseHeader };
}

function audit(c: Ctx, fields: Record<string, unknown>): void {
  logEvent("payment", { request_id: c.get("requestId"), network: c.get("config").network, ...fields });
}
