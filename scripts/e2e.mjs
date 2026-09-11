/**
 * End-to-end run against a deployed testnet. Pays real testnet USDC with the official
 * x402 client and walks every user-facing path: docs, uploads of each content family,
 * rejected content, signed share links (tamper, revoke, clamp), passwords (set, wrong,
 * browser page, form, change, remove, lockout), read quota and pay-on-read, extend,
 * idempotency, feedback, delete, a real headless browser on the share domain, and an
 * on-chain reconciliation of what PAY_TO received.
 *
 * Env: API=https://api-host  E2E_PRIVATE_KEY=0x...  (wallet funded with Base Sepolia USDC)
 *      CHROME=/path/to/chromium (optional, default /opt/pw-browsers/chromium)
 * Run: NODE_USE_ENV_PROXY=1 node scripts/e2e.mjs
 * Needs playwright-core for the browser steps (npm i --no-save playwright-core).
 * Cost: about 0.12 USDC per run. Exit code 1 if any step fails.
 */
import { readFileSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, fallback, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const API = (process.env.API ?? "").replace(/\/$/, "");
const KEY = process.env.E2E_PRIVATE_KEY;
if (!API || !KEY) throw new Error("API and E2E_PRIVATE_KEY are required");

// ---------------------------------------------------------------------------
// Transport: one retry on a client-side network error, x402 payment wrapper
// ---------------------------------------------------------------------------

// Every request gets a timeout: a connection that hangs at the proxy otherwise sits for
// undici's 300 s default before surfacing as "fetch failed".
const REQUEST_TIMEOUT_MS = 20_000;
const PAID_REQUEST_TIMEOUT_MS = 90_000; // verify + settle at the facilitator can take a while
const timeoutFor = (input, init) => {
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return h.has("payment-signature") ? PAID_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
};
// One retry on a client-side network error (undici "fetch failed": connection refused, reset,
// proxy hiccup, or our own timeout). Never on an HTTP response: a 402 or 5xx is the server's
// answer and is reported as is. A retried paid request reuses the same signed payload, so the
// server's nonce and idempotency checks rule out a double charge.
const NETWORK_RETRY_DELAY_MS = 1000;
const isNetworkError = (err) => (err instanceof TypeError && /fetch failed/i.test(String(err.message))) || err?.name === "TimeoutError" || err?.name === "AbortError";
const fetchWithRetry = async (input, init) => {
  // The x402 client passes a Request whose body is consumed by the first attempt: clone it first.
  const retryInput = input instanceof Request ? input.clone() : input;
  const t = Date.now();
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutFor(input, init)) });
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    const cause = err.cause?.code ?? err.cause?.message ?? err.name ?? "";
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const url = input instanceof Request ? input.url : String(input);
    console.log("RETRY", method, url, `network error after ${Date.now() - t}ms, retrying once:`, cause);
    await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS));
    return fetch(retryInput, { ...init, signal: AbortSignal.timeout(timeoutFor(input, init)) });
  }
};

const account = privateKeyToAccount(KEY);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const paidOnce = wrapFetchWithPayment(fetchWithRetry, new x402HTTPClient(client));
// The public testnet facilitator sometimes fails to broadcast (its own hot wallet races on
// nonces: "replacement transaction underpriced"). The API answers 402 "Payment settlement
// failed ... Nothing was stored" and asks for a fresh payment, so do what an x402 client does:
// sign again. Only for that specific failure, never for any other 402.
const SETTLE_RETRIES = 2;
const paid = async (url, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await paidOnce(url, init);
    if (res.status !== 402 || attempt >= SETTLE_RETRIES) return res;
    const body = await res.clone().json().catch(() => ({}));
    const settleFailed = body?.x402?.error === "invalid_exact_evm_transaction_failed" || /^Payment settlement failed/.test(body?.message ?? "");
    const facilitatorDown = body?.x402?.error === "facilitator_unavailable";
    if (!settleFailed && !facilitatorDown) return res;
    console.log("RETRY", facilitatorDown ? "facilitator did not answer verify" : "settlement failed at the facilitator", "- signing a fresh payment:", String(body.message ?? "").split("\n")[0].slice(0, 120));
    await new Promise((r) => setTimeout(r, 3000));
  }
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = [];
const seenTx = new Set();
const step = async (name, fn) => {
  const t = Date.now();
  try {
    const out = (await fn()) ?? {};
    results.push({ name, ok: true, ...out });
    console.log("PASS", name, JSON.stringify(out), `${Date.now() - t}ms`);
    return out;
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
    console.log("FAIL", name, String(err?.message ?? err));
    return undefined;
  }
};
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};
const tx = (res) => {
  const h = res.headers.get("PAYMENT-RESPONSE");
  const t = h ? decodePaymentResponseHeader(h).transaction : undefined;
  if (t) seenTx.add(t);
  return t;
};
const okOr = async (res, wanted, what) => {
  if (res.status !== wanted) throw new Error(`${what}: expected ${wanted}, got ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
};
const noTx = (res) => expect(!res.headers.get("PAYMENT-RESPONSE"), "a payment was settled where none should be");
const bearer = (secret) => ({ Authorization: `Bearer ${secret}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function upload(body, { contentType, ttlDays = 1, label, idemKey } = {}) {
  const q = new URLSearchParams({ ttl_days: String(ttlDays), ...(label ? { label } : {}) });
  const headers = { ...(contentType ? { "Content-Type": contentType } : {}), ...(idemKey ? { "Idempotency-Key": idemKey } : {}) };
  const res = await paid(`${API}/v1/items?${q}`, { method: "POST", headers, body });
  return { res, item: await res.json().catch(() => ({})) };
}
async function status(item) {
  const res = await fetchWithRetry(item.links.status, { headers: bearer(item.secret) });
  expect(res.status === 200, `status ${res.status}`);
  return res.json();
}
async function makeLink(item, expiresIn = 600) {
  const res = await fetchWithRetry(item.links.share, { method: "POST", headers: { ...bearer(item.secret), "Content-Type": "application/json" }, body: JSON.stringify({ expires_in: expiresIn }) });
  expect(res.status === 200, `link creation ${res.status}`);
  return res.json();
}
async function remove(item) {
  const res = await fetchWithRetry(item.links.delete, { method: "DELETE", headers: bearer(item.secret) });
  expect(res.status === 204, `delete ${res.status}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scriptsDir = new URL("./", import.meta.url);
const probeHtml = readFileSync(new URL("sandbox-probe.html", scriptsDir), "utf8");
const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const csvText = "name,score\nalpha,1\nbeta,2\n";
const zipBytes = Buffer.concat([Buffer.from("PK\x03\x04", "binary"), Buffer.alloc(64, 1)]);
const PASSWORD = "correct-horse-battery";
const PASSWORD2 = "another-long-password-2";

console.log("wallet", account.address, "api", API);

// ---------------------------------------------------------------------------
// 0. Pricing, docs, PAY_TO discovery, opening balance
// ---------------------------------------------------------------------------

let DL;
let payTo;
let priceAtomic;
let usdc;
const chain = createPublicClient({ chain: baseSepolia, transport: fallback([http("https://sepolia.base.org", { timeout: 15_000 }), http("https://base-sepolia-rpc.publicnode.com", { timeout: 15_000 })], { retryCount: 1 }) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const balanceOf = (addr) => chain.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [addr] });
let openingBalance;

await step("DOC docs and pricing", async () => {
  const pricing = await fetchWithRetry(`${API}/v1/pricing`);
  expect(pricing.status === 200, `pricing ${pricing.status}`);
  expect(pricing.headers.get("x-request-id"), "no X-Request-Id");
  const p = await pricing.json();
  expect(p.protocol === "x402" && p.upload === "0.01", "unexpected pricing body");
  for (const path of ["/llms.txt", "/openapi.json", "/tools.json", "/terms"]) {
    const r = await fetchWithRetry(`${API}${path}`);
    expect(r.status === 200, `${path} ${r.status}`);
    if (path === "/openapi.json") {
      const doc = await r.json();
      expect(doc.openapi && doc.paths?.["/v1/items"], "openapi.json is missing /v1/items");
    }
    if (path === "/tools.json") {
      const doc = await r.json();
      const tools = Array.isArray(doc) ? doc : (doc.tools ?? []);
      expect(tools.length === 7, `tools.json has ${tools.length} tools, expected 7`);
    }
  }
  return { max_bytes: p.max_bytes, max_ttl_days: p.max_ttl_days };
});

await step("UP-01 402 without payment carries PAY_TO and the x402 body", async () => {
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetchWithRetry(`${API}/v1/items?ttl_days=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      break;
    } catch (err) {
      if (attempt >= 3 || !isNetworkError(err)) throw err;
    }
  }
  expect(res.status === 402, `expected 402, got ${res.status}`);
  expect(res.headers.get("payment-required"), "no PAYMENT-REQUIRED header");
  const body = await res.json();
  const acc = body.x402?.accepts?.[0];
  expect(body.error === "payment_required" && acc?.network === "eip155:84532" && acc?.amount === "10000", "unexpected 402 body");
  payTo = acc.payTo;
  usdc = acc.asset;
  priceAtomic = BigInt(acc.amount);
  openingBalance = await balanceOf(payTo);
  return { pay_to: payTo, opening_balance_atomic: openingBalance.toString() };
});

// ---------------------------------------------------------------------------
// 1. Uploads of each content family, rejected content, retrieval headers
// ---------------------------------------------------------------------------

const items = {};

await step("E2E-01 upload JSON", async () => {
  const { res, item } = await upload(JSON.stringify({ e2e: true, at: new Date().toISOString() }), { contentType: "application/json", label: "e2e" });
  expect(res.status === 201, `${res.status} ${JSON.stringify(item)}`);
  expect(item.content_type === "application/json" && item.secret?.startsWith("sk_") && item.reads_remaining === 100, "unexpected item object");
  expect(item.payment?.tx && item.payment.amount === "0.01", "payment block missing from the item");
  items.json = item;
  return { id: item.id, tx: tx(res) };
});
if (!items.json) {
  console.log("\ncannot continue without a stored item");
  process.exit(1);
}
DL = new URL((await makeLink(items.json)).url).origin;
console.log("share origin", DL);

await step("UP-04 upload HTML, PNG, PDF and CSV", async () => {
  const out = {};
  for (const [name, body, contentType, expected] of [
    ["html", probeHtml, "text/html", "text/html"],
    ["png", png1x1, "image/png", "image/png"],
    ["pdf", pdfBytes, "application/octet-stream", "application/pdf"],
    ["csv", csvText, "text/csv", "text/csv"],
  ]) {
    const { res, item } = await upload(body, { contentType, ttlDays: 2 });
    expect(res.status === 201, `${name}: ${res.status} ${JSON.stringify(item)}`);
    expect(item.content_type === expected, `${name}: detected ${item.content_type}, expected ${expected}`);
    items[name] = item;
    out[name] = { id: item.id, tx: tx(res) };
  }
  return out;
});

await step("UP-05 forbidden type is rejected after verify, before settle", async () => {
  const { res, item } = await upload(zipBytes, { contentType: "application/zip" });
  expect(res.status === 415, `expected 415, got ${res.status} ${JSON.stringify(item)}`);
  expect(item.error === "unsupported_type" && Array.isArray(item.allowed_content_types), "415 body lacks the allowed list");
  noTx(res);
  return { allowed: item.allowed_content_types.length };
});

await step("UP-23 empty body is rejected without charge", async () => {
  const { res, item } = await upload("", { contentType: "text/plain" });
  expect(res.status === 400, `expected 400, got ${res.status} ${JSON.stringify(item)}`);
  noTx(res);
});

await step("GET-01 retrieve JSON byte for byte, headers, counter", async () => {
  const res = await fetchWithRetry(items.json.links.self, { headers: bearer(items.json.secret) });
  expect(res.status === 200, `${res.status}`);
  const body = await res.json();
  expect(body.e2e === true, "body mismatch");
  expect(res.headers.get("content-type")?.startsWith("application/json"), "content-type");
  expect(res.headers.get("x-reads-remaining") === "99", `x-reads-remaining ${res.headers.get("x-reads-remaining")}`);
  expect(res.headers.get("x-content-type-options") === "nosniff" && res.headers.get("cache-control") === "no-store", "base headers");
  return { reads_remaining: res.headers.get("x-reads-remaining") };
});

await step("GET-02/03 HTML inline with sandbox CSP, PNG as attachment", async () => {
  const html = await fetchWithRetry(items.html.links.self, { headers: bearer(items.html.secret) });
  expect(html.status === 200 && html.headers.get("content-type")?.startsWith("text/html"), `html ${html.status}`);
  const csp = html.headers.get("content-security-policy") ?? "";
  expect(/sandbox allow-scripts allow-forms allow-popups/.test(csp) && !/allow-same-origin/.test(csp), `csp: ${csp}`);
  expect(!html.headers.get("content-disposition"), "html must be inline");
  const png = await fetchWithRetry(items.png.links.self, { headers: bearer(items.png.secret) });
  expect(png.status === 200 && png.headers.get("content-type") === "image/png", `png ${png.status}`);
  expect(/^attachment; filename="itm_.*\.png"$/.test(png.headers.get("content-disposition") ?? ""), `png disposition: ${png.headers.get("content-disposition")}`);
  expect(Buffer.from(await png.arrayBuffer()).equals(png1x1), "png bytes differ");
  return { csp };
});

await step("GET-04/05 wrong or missing secret is 404", async () => {
  const wrong = await fetchWithRetry(items.json.links.self, { headers: bearer(items.png.secret) });
  const missing = await fetchWithRetry(items.json.links.self);
  expect(wrong.status === 404 && missing.status === 404, `${wrong.status}/${missing.status}`);
  expect((await wrong.json()).error === "not_found", "error code");
});

await step("ST-01 status has no secret and full links", async () => {
  const s = await status(items.json);
  expect(!("secret" in s) && s.has_password === false && s.label === "e2e", "status shape");
  expect(Object.keys(s.links).sort().join() === "delete,extend,reads,self,share,status", "links");
  return { reads_remaining: s.reads_remaining };
});

// ---------------------------------------------------------------------------
// 2. Signed share links on the share domain
// ---------------------------------------------------------------------------

let htmlLink;
await step("LNK-01/02 signed link serves HTML inline on the share domain", async () => {
  htmlLink = await makeLink(items.html, 600);
  const u = new URL(htmlLink.url);
  expect(u.origin === DL && u.pathname === `/d/${items.html.id}`, `link url ${htmlLink.url}`);
  expect(u.searchParams.get("exp") && u.searchParams.get("gen") === "1" && u.searchParams.get("sig"), "link params");
  expect(htmlLink.clamped_to_item_expiry === false, "unexpected clamp");
  const res = await fetchWithRetry(htmlLink.url);
  expect(res.status === 200 && res.headers.get("content-type")?.startsWith("text/html"), `${res.status} ${res.headers.get("content-type")}`);
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(/sandbox allow-scripts allow-forms allow-popups/.test(csp) && !/allow-same-origin/.test(csp), `csp ${csp}`);
  expect(!res.headers.get("content-disposition"), "html inline");
  expect(res.headers.get("referrer-policy") === "no-referrer" && res.headers.get("x-content-type-options") === "nosniff" && res.headers.get("cache-control") === "no-store", "DL-06 headers");
  expect(!res.headers.get("set-cookie"), "DL-07 no cookies");
  expect((await res.text()).includes('id="h"'), "body is the probe page");
  return { url: htmlLink.url, expires_at: htmlLink.expires_at };
});

await step("DL-05 PNG, PDF and CSV links are attachments with the right filename", async () => {
  const out = {};
  for (const [name, ext, type] of [["png", ".png", "image/png"], ["pdf", ".pdf", "application/pdf"], ["csv", ".csv", "text/csv"]]) {
    const link = await makeLink(items[name], 600);
    const res = await fetchWithRetry(link.url);
    expect(res.status === 200 && res.headers.get("content-type") === type, `${name}: ${res.status} ${res.headers.get("content-type")}`);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd === `attachment; filename="${items[name].id}${ext}"`, `${name}: ${cd}`);
    out[name] = cd;
  }
  return out;
});

await step("LNK-04 link cannot outlive the item", async () => {
  const link = await makeLink(items.json, 30 * 86400);
  const s = await status(items.json);
  const toSec = (iso) => Math.floor(Date.parse(iso) / 1000);
  expect(link.clamped_to_item_expiry === true && toSec(link.expires_at) === toSec(s.expires_at), `not clamped to the item expiry ${s.expires_at}: ${JSON.stringify(link)}`);
});

await step("LNK-05/06 tampered signature or expiry is 404", async () => {
  const u1 = new URL(htmlLink.url);
  const sig = u1.searchParams.get("sig");
  u1.searchParams.set("sig", (sig[0] === "0" ? "1" : "0") + sig.slice(1));
  const u2 = new URL(htmlLink.url);
  u2.searchParams.set("exp", String(Number(u2.searchParams.get("exp")) + 3600));
  const r1 = await fetchWithRetry(u1);
  const r2 = await fetchWithRetry(u2);
  expect(r1.status === 404 && r2.status === 404, `${r1.status}/${r2.status}`);
});

await step("LNK-07/08 revoke kills old links, a new link works", async () => {
  const rev = await fetchWithRetry(`${items.html.links.share}/revoke`, { method: "POST", headers: bearer(items.html.secret) });
  expect(rev.status === 204, `revoke ${rev.status}`);
  const old = await fetchWithRetry(htmlLink.url);
  expect(old.status === 404, `old link ${old.status}`);
  htmlLink = await makeLink(items.html, 600);
  expect(new URL(htmlLink.url).searchParams.get("gen") === "2", "generation did not advance");
  const fresh = await fetchWithRetry(htmlLink.url);
  expect(fresh.status === 200, `new link ${fresh.status}`);
  return { gen: 2 };
});

await step("DL-08 domains are separated", async () => {
  const apiOnShare = await fetchWithRetry(`${DL}/v1/items/${items.json.id}`, { headers: bearer(items.json.secret) });
  const u = new URL(htmlLink.url);
  const dlOnApi = await fetchWithRetry(`${API}${u.pathname}${u.search}`);
  expect(apiOnShare.status === 404 && dlOnApi.status === 404, `${apiOnShare.status}/${dlOnApi.status}`);
});

await step("PWD-17 an item without password is 404 on the share domain", async () => {
  const res = await fetchWithRetry(`${DL}/d/${items.pdf.id}`, { headers: { Accept: "application/json" } });
  expect(res.status === 404, `${res.status}`);
});

// ---------------------------------------------------------------------------
// 3. Passwords
// ---------------------------------------------------------------------------

const pwUrl = (item) => `${DL}/d/${item.id}`;
const setPassword = async (item, password) =>
  fetchWithRetry(`${item.links.self}/password`, { method: "PUT", headers: { ...bearer(item.secret), "Content-Type": "application/json" }, body: JSON.stringify({ password }) });

await step("PWD-01/02 set a password, reject a short one", async () => {
  const short = await setPassword(items.pdf, "elevenchars");
  expect(short.status === 400, `short password ${short.status}`);
  const ok = await setPassword(items.pdf, PASSWORD);
  expect(ok.status === 204, `set password ${ok.status}`);
  expect((await status(items.pdf)).has_password === true, "has_password");
});

await step("PWD-04/05 X-Password right then wrong", async () => {
  const right = await fetchWithRetry(pwUrl(items.pdf), { headers: { "X-Password": PASSWORD, Accept: "application/json" } });
  expect(right.status === 200 && right.headers.get("content-type") === "application/pdf", `right ${right.status}`);
  expect(Buffer.from(await right.arrayBuffer()).equals(pdfBytes), "pdf bytes differ");
  const wrong = await fetchWithRetry(pwUrl(items.pdf), { headers: { "X-Password": "definitely-not-it", Accept: "application/json" } });
  expect(wrong.status === 404, `wrong ${wrong.status}`);
  return { reads_remaining: right.headers.get("x-reads-remaining") };
});

await step("PWD-06/07 no password: 404 for agents, a safe page for browsers", async () => {
  const agent = await fetchWithRetry(pwUrl(items.pdf), { headers: { Accept: "application/json" } });
  expect(agent.status === 404, `agent ${agent.status}`);
  const browser = await fetchWithRetry(pwUrl(items.pdf), { headers: { Accept: "text/html,application/xhtml+xml" } });
  expect(browser.status === 200 && browser.headers.get("content-type")?.startsWith("text/html"), `browser ${browser.status}`);
  const page = await browser.text();
  expect(page.includes(`action="/d/${items.pdf.id}"`) && page.includes('type="password"'), "password form");
  expect(!page.includes("%PDF"), "item content leaked into the page");
  expect(!browser.headers.get("set-cookie"), "no cookies");
  const csp = browser.headers.get("content-security-policy") ?? "";
  expect(/default-src 'none'/.test(csp) && /form-action 'self'/.test(csp), `csp ${csp}`);
  return { csp };
});

await step("PWD-08 the form posts the password and gets the file", async () => {
  const res = await fetchWithRetry(pwUrl(items.pdf), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body: `password=${encodeURIComponent(PASSWORD)}` });
  expect(res.status === 200 && res.headers.get("content-type") === "application/pdf", `${res.status} ${res.headers.get("content-type")}`);
  expect((res.headers.get("content-disposition") ?? "").startsWith("attachment"), "pdf attachment");
  const wrong = await fetchWithRetry(pwUrl(items.pdf), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body: "password=wrong-password-here" });
  expect(wrong.status === 200 && (await wrong.text()).includes("Wrong password"), `wrong form ${wrong.status}`);
});

await step("LNK-09 a signed link bypasses the password", async () => {
  const link = await makeLink(items.pdf, 600);
  const res = await fetchWithRetry(link.url);
  expect(res.status === 200 && res.headers.get("content-type") === "application/pdf", `${res.status}`);
});

await step("PWD-09 change password: old fails, new works", async () => {
  const put = await setPassword(items.pdf, PASSWORD2);
  expect(put.status === 204, `change ${put.status}`);
  const old = await fetchWithRetry(pwUrl(items.pdf), { headers: { "X-Password": PASSWORD, Accept: "application/json" } });
  const fresh = await fetchWithRetry(pwUrl(items.pdf), { headers: { "X-Password": PASSWORD2, Accept: "application/json" } });
  expect(old.status === 404 && fresh.status === 200, `old ${old.status}, new ${fresh.status}`);
});

await step("PWD-10 remove password", async () => {
  const del = await fetchWithRetry(`${items.pdf.links.self}/password`, { method: "DELETE", headers: bearer(items.pdf.secret) });
  expect(del.status === 204, `remove ${del.status}`);
  const res = await fetchWithRetry(pwUrl(items.pdf), { headers: { "X-Password": PASSWORD2, Accept: "application/json" } });
  expect(res.status === 404, `after removal ${res.status}`);
  expect((await status(items.pdf)).has_password === false, "has_password");
});

await step("PWD-11/14 five wrong passwords lock the item, the owner is unaffected", async () => {
  const put = await setPassword(items.csv, PASSWORD);
  expect(put.status === 204, `set ${put.status}`);
  for (let i = 0; i < 5; i++) {
    const r = await fetchWithRetry(pwUrl(items.csv), { headers: { "X-Password": `wrong-attempt-${i}-xxxx`, Accept: "application/json" } });
    expect(r.status === 404, `attempt ${i + 1}: ${r.status}`);
  }
  const locked = await fetchWithRetry(pwUrl(items.csv), { headers: { "X-Password": PASSWORD, Accept: "application/json" } });
  expect(locked.status === 423 && locked.headers.get("retry-after"), `expected 423 with Retry-After, got ${locked.status}`);
  const owner = await fetchWithRetry(items.csv.links.self, { headers: bearer(items.csv.secret) });
  expect(owner.status === 200 && (await owner.text()) === csvText, `owner ${owner.status}`);
  return { retry_after: locked.headers.get("retry-after") };
});

// ---------------------------------------------------------------------------
// 4. Read quota, pay-on-read, extend, read pack
// ---------------------------------------------------------------------------

await step("E2E-03 100 reads, then the 101st is paid automatically", async () => {
  const { res, item } = await upload(JSON.stringify({ quota: true }), { contentType: "application/json", label: "quota" });
  expect(res.status === 201, `upload ${res.status}`);
  tx(res);
  items.quota = item;
  const url = item.links.self;
  // Sequential on purpose: the read counter is soft under concurrency (TESTS.md CNT-05, a
  // burst of parallel reads can lose decrements), and this scenario is about the quota edge.
  for (let i = 0; i < 100; i++) {
    const r = await fetchWithRetry(url, { headers: bearer(item.secret) });
    expect(r.status === 200, `read ${i + 1}: ${r.status}`);
    await r.arrayBuffer();
  }
  // The counter is decremented after the response, so give it a moment; then read the
  // remainder one by one until status says 0 (a decrement lost to a write conflict is
  // logged as read_counter_failed on the server and counted here as an extra read).
  await sleep(2000);
  let s = await status(item);
  let extra = 0;
  while (s.reads_remaining > 0 && extra < 100) {
    const r = await fetchWithRetry(url, { headers: bearer(item.secret) });
    expect(r.status === 200, `extra read ${r.status}`);
    await r.arrayBuffer();
    extra++;
    await sleep(300);
    s = await status(item);
  }
  expect(s.reads_remaining === 0, `reads_remaining is ${s.reads_remaining} after 100 + ${extra} reads`);
  const gone = await fetchWithRetry(url, { headers: bearer(item.secret) });
  expect(gone.status === 402, `expected 402, got ${gone.status}`);
  const goneBody = await gone.json();
  expect(goneBody.error === "reads_exhausted" && goneBody.expires_at && goneBody.x402?.accepts?.[0]?.amount === "10000", `402 body ${JSON.stringify(goneBody).slice(0, 200)}`);
  const paidRead = await paid(url, { headers: bearer(item.secret) });
  await okOr(paidRead, 200, "paid read");
  expect((await paidRead.json()).quota === true, "content after paid read");
  expect(paidRead.headers.get("x-reads-remaining") === "999", `x-reads-remaining ${paidRead.headers.get("x-reads-remaining")}`);
  return { id: item.id, reads_lost_to_conflicts: extra, paid_read_tx: tx(paidRead) };
});

await step("E2E-07 extend", async () => {
  const before = await status(items.json);
  const res = await paid(items.json.links.extend, { method: "POST", headers: { ...bearer(items.json.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 3 }) });
  await okOr(res, 200, "extend");
  const body = await res.json();
  expect(Date.parse(body.expires_at) > Date.parse(before.expires_at), "expiry did not move");
  return { expires_at: body.expires_at, tx: tx(res) };
});

await step("EXT invalid: not later than the current expiry is 400 without charge", async () => {
  const res = await paid(items.json.links.extend, { method: "POST", headers: { ...bearer(items.json.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 1 }) });
  expect(res.status === 400, `${res.status}`);
  noTx(res);
});

await step("E2E-07 read pack", async () => {
  const res = await paid(items.json.links.reads, { method: "POST" });
  await okOr(res, 200, "read pack");
  const body = await res.json();
  expect(body.reads_remaining > 1000, `reads_remaining ${body.reads_remaining}`);
  return { reads_remaining: body.reads_remaining, tx: tx(res) };
});

// ---------------------------------------------------------------------------
// 5. Idempotency
// ---------------------------------------------------------------------------

await step("E2E-06 idempotent replay of the upload", async () => {
  const key = `e2e-${Date.now()}`;
  const a = await upload('{"k":1}', { contentType: "application/json", idemKey: key });
  expect(a.res.status === 201, `first ${a.res.status}`);
  tx(a.res);
  const b = await upload('{"k":1}', { contentType: "application/json", idemKey: key });
  expect(b.res.status === 201, `replay ${b.res.status}`);
  expect(a.item.id === b.item.id && a.item.secret === b.item.secret && a.item.payment.tx === b.item.payment.tx, "replay produced a different item or tx");
  const conflict = await upload('{"k":2}', { contentType: "application/json", idemKey: key });
  expect(conflict.res.status === 409 && conflict.item.error === "idempotency_conflict", `conflict ${conflict.res.status}`);
  noTx(conflict.res);
  await remove(a.item);
  return { id: a.item.id, tx: a.item.payment.tx };
});

// ---------------------------------------------------------------------------
// 6. Real browser on the share domain (E2E-04, E2E-05, DL-03)
// ---------------------------------------------------------------------------

async function withBrowser(fn) {
  const { chromium } = await import("playwright-core");
  // Same egress as node: through the env proxy only when NODE_USE_ENV_PROXY is set. QUIC is
  // off because some sandboxes block UDP and Chromium then fails instead of falling back.
  const proxy = process.env.NODE_USE_ENV_PROXY ? (process.env.HTTPS_PROXY ?? process.env.https_proxy) : undefined;
  const args = ["--no-sandbox", "--disable-quic", ...(proxy ? [] : ["--no-proxy-server"])];
  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/opt/pw-browsers/chromium", args, ...(proxy ? { proxy: { server: proxy } } : {}) });
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    return await fn(await ctx.newPage());
  } finally {
    await browser.close();
  }
}

await step("E2E-04/DL-03 the HTML link renders in Chromium and the script is sandboxed", async () =>
  withBrowser(async (page) => {
    const res = await page.goto(htmlLink.url, { waitUntil: "commit", timeout: 20000 });
    expect(res?.status() === 200, `status ${res?.status()}`);
    await page.waitForFunction(() => document.getElementById("h")?.textContent !== "pending", null, { timeout: 10000 });
    const probe = JSON.parse(await page.textContent("#h"));
    expect(probe.scriptRan === true, "script did not run");
    expect(String(probe.cookieSet).startsWith("blocked") && String(probe.localStorage).startsWith("blocked") && probe.windowOrigin === "null", `sandbox leak: ${JSON.stringify(probe)}`);
    return probe;
  }),
);

await step("E2E-05 password page in Chromium: wrong then right password", async () => {
  const put = await setPassword(items.png, PASSWORD);
  expect(put.status === 204, `set ${put.status}`);
  return withBrowser(async (page) => {
    const res = await page.goto(pwUrl(items.png), { waitUntil: "load", timeout: 20000 });
    expect(res?.status() === 200 && (await page.title()) === "Password required", `page ${res?.status()} ${await page.title()}`);
    await page.fill("#p", "this-is-the-wrong-one");
    await page.click("button[type=submit]");
    await page.waitForSelector(".err", { timeout: 10000 });
    expect((await page.textContent(".err")).includes("Wrong password"), "wrong password message");
    const download = page.waitForEvent("download", { timeout: 15000 });
    await page.fill("#p", PASSWORD);
    await page.click("button[type=submit]");
    const file = await download;
    expect(file.suggestedFilename() === `${items.png.id}.png`, `filename ${file.suggestedFilename()}`);
    const bytes = readFileSync(await file.path());
    expect(Buffer.from(bytes).equals(png1x1), "downloaded bytes differ");
    return { filename: file.suggestedFilename(), bytes: bytes.length };
  });
});

// ---------------------------------------------------------------------------
// 7. Feedback, delete, cleanup, reconciliation
// ---------------------------------------------------------------------------

await step("FB-05/E2E-09 abuse report with item_id", async () => {
  const res = await fetchWithRetry(`${API}/v1/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "abuse", item_id: items.json.id, message: "e2e run, ignore" }) });
  if (res.status === 429) {
    expect(res.headers.get("retry-after") === "3600", "429 without Retry-After: 3600");
    return { note: "rate limited per RL-02 (5 reports per hour from this address), headers correct" };
  }
  expect(res.status === 202, `${res.status}`);
  const body = await res.json();
  expect(body.received === true && body.id, "body");
  return { id: body.id };
});

await step("DEL-01/02/03 delete: 204, then 404 for status, re-delete and the signed link", async () => {
  await remove(items.html);
  const st = await fetchWithRetry(items.html.links.status, { headers: bearer(items.html.secret) });
  const again = await fetchWithRetry(items.html.links.delete, { method: "DELETE", headers: bearer(items.html.secret) });
  const link = await fetchWithRetry(htmlLink.url);
  expect(st.status === 404 && again.status === 404 && link.status === 404, `${st.status}/${again.status}/${link.status}`);
});

await step("cleanup remaining items", async () => {
  const out = {};
  for (const name of ["json", "png", "pdf", "csv", "quota"]) {
    if (!items[name]) continue;
    await remove(items[name]);
    out[name] = "deleted";
  }
  return out;
});

const warnings = [];
await step("on-chain reconciliation: every settlement moved exactly one price to PAY_TO", async () => {
  expect(payTo && usdc && priceAtomic !== undefined, "PAY_TO and the asset were not discovered (UP-01 failed), nothing to reconcile against");
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topicAddr = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const verified = [];
  for (const hash of seenTx) {
    let receipt;
    for (let i = 0; i < 10 && !receipt; i++) {
      receipt = await chain.getTransactionReceipt({ hash }).catch(() => undefined);
      if (!receipt) await sleep(3000);
    }
    expect(receipt, `no receipt for ${hash}`);
    expect(receipt.status === "success", `${hash} reverted`);
    const transfers = receipt.logs.filter((l) => l.address.toLowerCase() === usdc.toLowerCase() && l.topics[0] === TRANSFER && l.topics[1] === topicAddr(account.address) && l.topics[2] === topicAddr(payTo));
    expect(transfers.length === 1 && BigInt(transfers[0].data) === priceAtomic, `${hash}: expected one USDC transfer of ${priceAtomic} from the payer to PAY_TO`);
    verified.push({ hash, block: receipt.blockNumber.toString() });
  }
  // Informational: the payer's total spend against what this run tracked. A difference means
  // the facilitator broadcast a transfer it then reported as failed (its hot wallet racing on
  // nonces), which the API cannot see. It is not a defect of the API and is not counted as a
  // failure, but it is worth knowing when the public testnet facilitator is flaky.
  const closing = await balanceOf(payTo);
  const untracked = closing - openingBalance - BigInt(seenTx.size) * priceAtomic;
  if (untracked !== 0n) warnings.push(`PAY_TO balance moved by ${untracked} atomic more than the ${seenTx.size} tracked settlements (facilitator-side duplicate or a stray settlement from a timed-out request)`);
  return { settlements: verified.length, received_usdc: (Number(BigInt(seenTx.size) * priceAtomic) / 1e6).toFixed(2), blocks: verified.map((v) => v.block) };
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log("  FAILED:", f.name, "->", f.error);
for (const w of warnings) console.log("  WARNING:", w);
process.exit(failed.length ? 1 : 0);
