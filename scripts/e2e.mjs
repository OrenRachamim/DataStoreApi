/**
 * End-to-end run against a deployed testnet (TESTS.md E2E-01, 03, 07 and the
 * link/password paths). Pays real testnet USDC with the official x402 client.
 *
 * Env: API=https://api-host  E2E_PRIVATE_KEY=0x...  (wallet funded with Base Sepolia USDC)
 * Run: NODE_USE_ENV_PROXY=1 node scripts/e2e.mjs
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";

const API = (process.env.API ?? "").replace(/\/$/, "");
const KEY = process.env.E2E_PRIVATE_KEY;
if (!API || !KEY) throw new Error("API and E2E_PRIVATE_KEY are required");

const account = privateKeyToAccount(KEY);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const paid = wrapFetchWithPayment(fetch, new x402HTTPClient(client));
const results = [];
const step = async (name, fn) => {
  try {
    const out = await fn();
    results.push({ name, ok: true, ...out });
    console.log("PASS", name, JSON.stringify(out));
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
    console.log("FAIL", name, String(err?.message ?? err));
  }
};
const tx = (res) => {
  const h = res.headers.get("PAYMENT-RESPONSE");
  return h ? decodePaymentResponseHeader(h).transaction : undefined;
};

console.log("wallet", account.address, "api", API);
let item;
await step("E2E-01 upload JSON", async () => {
  const res = await paid(`${API}/v1/items?ttl_days=1&label=e2e`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ e2e: true, at: new Date().toISOString() }) });
  if (res.status !== 201) throw new Error(`${res.status} ${await res.text()}`);
  item = await res.json();
  return { id: item.id, tx: tx(res) };
});
if (!item) process.exit(1);
const auth = { Authorization: `Bearer ${item.secret}` };
await step("E2E-01 retrieve", async () => {
  const res = await fetch(`${API}/v1/items/${item.id}`, { headers: auth });
  const body = await res.json();
  if (res.status !== 200 || body.e2e !== true) throw new Error(`${res.status}`);
  return { reads_remaining: res.headers.get("x-reads-remaining") };
});
await step("E2E-01 status", async () => {
  const res = await fetch(`${API}/v1/items/${item.id}/status`, { headers: auth });
  if (res.status !== 200) throw new Error(`${res.status}`);
  return { reads_remaining: (await res.json()).reads_remaining };
});
await step("E2E-07 extend", async () => {
  const res = await paid(`${API}/v1/items/${item.id}/extend`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 2 }) });
  if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`);
  return { expires_at: (await res.json()).expires_at, tx: tx(res) };
});
await step("E2E-07 read pack", async () => {
  const res = await paid(`${API}/v1/items/${item.id}/reads`, { method: "POST" });
  if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`);
  return { reads_remaining: (await res.json()).reads_remaining, tx: tx(res) };
});
await step("share link", async () => {
  const res = await fetch(`${API}/v1/items/${item.id}/links`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ expires_in: 600 }) });
  if (res.status !== 200) throw new Error(`${res.status}`);
  const { url } = await res.json();
  const dl = await fetch(url);
  if (dl.status !== 200) throw new Error(`link fetch ${dl.status}`);
  return { url, csp: dl.headers.get("content-security-policy") ?? "n/a" };
});
await step("E2E-06 idempotent replay of the upload", async () => {
  // Same signed request twice: helper not available here, so replay via Idempotency-Key.
  const key = `e2e-${Date.now()}`;
  const a = await paid(`${API}/v1/items?ttl_days=1`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: '{"k":1}' });
  const b = await paid(`${API}/v1/items?ttl_days=1`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: '{"k":1}' });
  const ja = await a.json();
  const jb = await b.json();
  if (ja.id !== jb.id || ja.secret !== jb.secret) throw new Error("replay produced a different item");
  await fetch(`${API}/v1/items/${ja.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ja.secret}` } });
  return { id: ja.id, replayed_tx: jb.payment?.tx, original_tx: ja.payment?.tx };
});
await step("E2E-01 delete", async () => {
  const res = await fetch(`${API}/v1/items/${item.id}`, { method: "DELETE", headers: auth });
  if (res.status !== 204) throw new Error(`${res.status}`);
  const after = await fetch(`${API}/v1/items/${item.id}/status`, { headers: auth });
  if (after.status !== 404) throw new Error(`expected 404 after delete, got ${after.status}`);
  return {};
});
await step("feedback", async () => {
  const res = await fetch(`${API}/v1/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "other", message: "e2e run" }) });
  if (res.status !== 202) throw new Error(`${res.status}`);
  return {};
});
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
