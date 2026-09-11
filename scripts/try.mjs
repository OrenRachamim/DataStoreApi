/**
 * Hands-on CLI for a deployed DataStore API. Pays with an x402 wallet where a call costs money.
 *
 * Env: API=https://api-host  WALLET_KEY=0x... (private key of a wallet with USDC on the API's network)
 *
 *   node scripts/try.mjs upload <file> [ttl_days] [label]    store a file (0.01 USDC), prints id, secret, links
 *   node scripts/try.mjs get <id> <secret> [out_file]        retrieve (free, counts one read)
 *   node scripts/try.mjs status <id> <secret>                item object (free)
 *   node scripts/try.mjs link <id> <secret> [seconds]        signed share link (free, default 1 hour)
 *   node scripts/try.mjs revoke <id> <secret>                invalidate every earlier link
 *   node scripts/try.mjs password <id> <secret> <password>   set or change the password (12 to 128 chars)
 *   node scripts/try.mjs nopassword <id> <secret>            remove the password
 *   node scripts/try.mjs extend <id> <secret> <ttl_days>     move the expiry (0.01 USDC)
 *   node scripts/try.mjs reads <id>                          buy 1000 reads (0.01 USDC)
 *   node scripts/try.mjs delete <id> <secret>
 *   node scripts/try.mjs balance                             wallet USDC balance
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";

const API = (process.env.API ?? "").replace(/\/$/, "");
const KEY = process.env.WALLET_KEY;
const [cmd, ...args] = process.argv.slice(2);
if (!API || !cmd) {
  console.error("Usage: API=https://... WALLET_KEY=0x... node scripts/try.mjs <command> ...  (see the header of this file)");
  process.exit(2);
}

const timed = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(90_000) });
let paid = timed;
let account;
if (KEY) {
  account = privateKeyToAccount(KEY);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  paid = wrapFetchWithPayment(timed, new x402HTTPClient(client));
}
const needWallet = () => {
  if (!KEY) {
    console.error("This command pays 0.01 USDC and needs WALLET_KEY.");
    process.exit(2);
  }
};
const auth = (secret) => ({ Authorization: `Bearer ${secret}` });
const show = async (res) => {
  const text = await res.text();
  let body = text;
  try {
    body = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  const tx = res.headers.get("PAYMENT-RESPONSE");
  console.log(`HTTP ${res.status}`);
  if (tx) console.log(`paid, tx https://sepolia.basescan.org/tx/${decodePaymentResponseHeader(tx).transaction}`);
  console.log(body);
  if (res.status >= 400) process.exit(1);
};
const MIME = { ".json": "application/json", ".html": "text/html", ".svg": "image/svg+xml", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

switch (cmd) {
  case "upload": {
    needWallet();
    const [file, ttl = "1", label] = args;
    const q = new URLSearchParams({ ttl_days: ttl, ...(label ? { label } : {}) });
    const type = MIME[extname(file).toLowerCase()];
    const res = await paid(`${API}/v1/items?${q}`, { method: "POST", headers: type ? { "Content-Type": type } : {}, body: readFileSync(file) });
    console.log(`uploaded ${basename(file)}`);
    await show(res);
    break;
  }
  case "get": {
    const [id, secret, out] = args;
    const res = await timed(`${API}/v1/items/${id}`, { headers: auth(secret) });
    console.log(`HTTP ${res.status}  type ${res.headers.get("content-type")}  reads left ${res.headers.get("x-reads-remaining")}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (out) {
      writeFileSync(out, bytes);
      console.log(`saved ${bytes.length} bytes to ${out}`);
    } else console.log(bytes.toString("utf8").slice(0, 2000));
    break;
  }
  case "status":
    await show(await timed(`${API}/v1/items/${args[0]}/status`, { headers: auth(args[1]) }));
    break;
  case "link": {
    const [id, secret, seconds = "3600"] = args;
    await show(await timed(`${API}/v1/items/${id}/links`, { method: "POST", headers: { ...auth(secret), "Content-Type": "application/json" }, body: JSON.stringify({ expires_in: Number(seconds) }) }));
    break;
  }
  case "revoke":
    await show(await timed(`${API}/v1/items/${args[0]}/links/revoke`, { method: "POST", headers: auth(args[1]) }));
    break;
  case "password": {
    const [id, secret, password] = args;
    await show(await timed(`${API}/v1/items/${id}/password`, { method: "PUT", headers: { ...auth(secret), "Content-Type": "application/json" }, body: JSON.stringify({ password }) }));
    // The share origin is only known from a link; a one-second link is enough to learn it.
    const probe = await (await timed(`${API}/v1/items/${id}/links`, { method: "POST", headers: { ...auth(secret), "Content-Type": "application/json" }, body: JSON.stringify({ expires_in: 1 }) })).json();
    console.log(`share page (asks for the password): ${new URL(probe.url).origin}/d/${id}`);
    break;
  }
  case "nopassword":
    await show(await timed(`${API}/v1/items/${args[0]}/password`, { method: "DELETE", headers: auth(args[1]) }));
    break;
  case "extend": {
    needWallet();
    const [id, secret, ttl] = args;
    await show(await paid(`${API}/v1/items/${id}/extend`, { method: "POST", headers: { ...auth(secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: Number(ttl) }) }));
    break;
  }
  case "reads":
    needWallet();
    await show(await paid(`${API}/v1/items/${args[0]}/reads`, { method: "POST" }));
    break;
  case "delete":
    await show(await timed(`${API}/v1/items/${args[0]}`, { method: "DELETE", headers: auth(args[1]) }));
    break;
  case "balance": {
    needWallet();
    const pricing = await (await timed(`${API}/v1/pricing`)).json();
    const r402 = await (await timed(`${API}/v1/items`, { method: "POST" })).json();
    const usdc = r402.x402.accepts[0].asset;
    const chain = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org", { timeout: 15_000 }) });
    const bal = await chain.readContract({ address: usdc, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [account.address] });
    console.log(`${account.address} has ${formatUnits(bal, 6)} USDC on ${pricing.network}`);
    break;
  }
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}
