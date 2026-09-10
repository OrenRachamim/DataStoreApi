import { env, SELF } from "cloudflare:test";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse, PaymentRequired } from "@x402/core/types";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { authorizationTypes } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, verifyTypedData, type Hex } from "viem";
import { setFacilitatorForTests } from "../src/payment";
import { testHooks } from "../src/hooks";

export const NETWORK = "eip155:84532";
export const PAY_TO = "0x0000000000000000000000000000000000000001";
export const API = "http://localhost:8787";

// Two deterministic test wallets.
export const walletA = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const walletB = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

export type FacilitatorMode = "ok" | "verify_fail" | "settle_fail" | "settle_timeout";

export class MockFacilitator implements FacilitatorClient {
  mode: FacilitatorMode = "ok";
  usedNonces = new Set<string>();
  verifyCalls: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }> = [];
  settleCalls: Array<{ payload: PaymentPayload; requirements: PaymentRequirements }> = [];

  reset(): void {
    this.mode = "ok";
    this.usedNonces.clear();
    this.verifyCalls = [];
    this.settleCalls = [];
  }

  private async check(payload: PaymentPayload, req: PaymentRequirements): Promise<{ ok: true; payer: string } | { ok: false; reason: string }> {
    const p = payload.payload as { authorization: Record<string, string>; signature: Hex };
    const a = p.authorization;
    if (payload.accepted.network !== req.network) return { ok: false, reason: "network_mismatch" };
    if (a.value !== req.amount) return { ok: false, reason: "invalid_exact_evm_payload_authorization_value" };
    if (getAddress(a.to) !== getAddress(req.payTo)) return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch" };
    const now = Math.floor(Date.now() / 1000);
    if (Number(a.validBefore) <= now) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before" };
    if (this.usedNonces.has(a.nonce.toLowerCase())) return { ok: false, reason: "invalid_exact_evm_nonce_already_used" };
    const chainId = Number.parseInt(req.network.split(":")[1], 10);
    const extra = req.extra as { name: string; version: string };
    const valid = await verifyTypedData({
      address: getAddress(a.from),
      domain: { name: extra.name, version: extra.version, chainId, verifyingContract: getAddress(req.asset) },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: { from: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as Hex },
      signature: p.signature,
    });
    if (!valid) return { ok: false, reason: "invalid_signature" };
    return { ok: true, payer: getAddress(a.from) };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls.push({ payload, requirements });
    if (this.mode === "verify_fail") return { isValid: false, invalidReason: "insufficient_funds", invalidMessage: "Mock: insufficient funds" };
    const r = await this.check(payload, requirements);
    if (!r.ok) return { isValid: false, invalidReason: r.reason, invalidMessage: `Mock verify failed: ${r.reason}` };
    return { isValid: true, payer: r.payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls.push({ payload, requirements });
    if (this.mode === "settle_fail") return { success: false, errorReason: "mock_settle_failed", errorMessage: "Mock: settle failed", transaction: "", network: requirements.network };
    if (this.mode === "settle_timeout") throw new Error("Mock: facilitator timeout");
    const r = await this.check(payload, requirements);
    if (!r.ok) return { success: false, errorReason: r.reason, errorMessage: `Mock settle failed: ${r.reason}`, transaction: "", network: requirements.network };
    const nonce = (payload.payload as { authorization: { nonce: string } }).authorization.nonce.toLowerCase();
    this.usedNonces.add(nonce);
    const tx = "0x" + nonce.slice(2, 34) + "a".repeat(32);
    return { success: true, transaction: tx, network: requirements.network, payer: r.payer };
  }

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK as `${string}:${string}` }], extensions: [], signers: {} };
  }
}

export const facilitator = new MockFacilitator();
setFacilitatorForTests(facilitator);

export async function clearBucket(): Promise<void> {
  const bucket = (env as unknown as { BUCKET: R2Bucket }).BUCKET;
  let cursor: string | undefined;
  do {
    const list = await bucket.list({ cursor, limit: 1000 });
    if (list.objects.length) await bucket.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

export function bucket(): R2Bucket {
  return (env as unknown as { BUCKET: R2Bucket }).BUCKET;
}

export async function listKeys(prefix = ""): Promise<string[]> {
  const list = await bucket().list({ prefix, limit: 1000 });
  return list.objects.map((o) => o.key).sort();
}

/** Reset everything a test could have changed. Call from beforeEach. */
export async function resetAll(): Promise<void> {
  await clearBucket();
  facilitator.reset();
  testHooks.beforeStore = undefined;
  testHooks.beforeSettle = undefined;
  testHooks.afterSettle = undefined;
}

export const rawFetch = (input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as string, init);

export function payingClient(account = walletA): x402HTTPClient {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  return new x402HTTPClient(client);
}

/** fetch that pays 402s automatically with the real x402 client library. */
export function payingFetch(account = walletA) {
  return wrapFetchWithPayment(rawFetch as typeof fetch, payingClient(account));
}

export interface UploadOptions {
  body?: BodyInit;
  contentType?: string | null;
  ttlDays?: number | string;
  label?: string;
  idempotencyKey?: string;
  account?: ReturnType<typeof privateKeyToAccount>;
  headers?: Record<string, string>;
}

export function uploadUrl(opts: UploadOptions = {}): string {
  const u = new URL(`${API}/v1/items`);
  if (opts.ttlDays !== undefined) u.searchParams.set("ttl_days", String(opts.ttlDays));
  if (opts.label !== undefined) u.searchParams.set("label", opts.label);
  return u.toString();
}

export function uploadInit(opts: UploadOptions = {}): RequestInit {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.contentType !== null) headers["Content-Type"] = opts.contentType ?? "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  return { method: "POST", headers, body: opts.body ?? JSON.stringify({ hello: "world" }) };
}

/** Upload with automatic payment. Returns the response. */
export async function upload(opts: UploadOptions = {}): Promise<Response> {
  return payingFetch(opts.account)(uploadUrl(opts), uploadInit(opts));
}

export interface StoredItem {
  id: string;
  secret: string;
  body: Record<string, unknown>;
}

export async function makeItem(opts: UploadOptions = {}): Promise<StoredItem> {
  const res = await upload(opts);
  if (res.status !== 201) throw new Error(`makeItem failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as Record<string, unknown>;
  return { id: body.id as string, secret: body.secret as string, body };
}

export function auth(secret: string): Record<string, string> {
  return { Authorization: `Bearer ${secret}` };
}

export async function get(id: string, secret: string, init: RequestInit = {}): Promise<Response> {
  return rawFetch(`${API}/v1/items/${id}`, { ...init, headers: { ...auth(secret), ...(init.headers as Record<string, string> | undefined) } });
}

export async function status(id: string, secret: string): Promise<Response> {
  return rawFetch(`${API}/v1/items/${id}/status`, { headers: auth(secret) });
}

/**
 * Manual payment construction for negative tests: fetch the 402, build a
 * payload with the real client, let the caller tamper with it, then send.
 */
export async function manualPay(
  url: string,
  init: RequestInit,
  tamper: (payload: PaymentPayload, required: PaymentRequired) => PaymentPayload | Promise<PaymentPayload>,
  account = walletA,
): Promise<Response> {
  const first = await rawFetch(url, init);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
  const client = payingClient(account);
  const payload = await client.createPaymentPayload(required);
  const tampered = await tamper(payload, required);
  return rawFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(tampered) } });
}

/** Build a signed payment header for a URL without sending the paid request. */
export async function signedHeaderFor(url: string, init: RequestInit, account = walletA): Promise<{ header: string; payload: PaymentPayload }> {
  const first = await rawFetch(url, init);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
  const payload = await payingClient(account).createPaymentPayload(required);
  return { header: encodePaymentSignatureHeader(payload), payload };
}

export async function expectError(res: Response, status: number, error: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`expected JSON error body, got ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status !== status || body.error !== error) {
    throw new Error(`expected ${status} ${error}, got ${res.status} ${body.error}: ${body.message}`);
  }
  if (typeof body.request_id !== "string") throw new Error("error body missing request_id");
  if (typeof body.action !== "object") throw new Error("error body missing action");
  return body;
}

/** Wait for background work (waitUntil) to land. */
export async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
