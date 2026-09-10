// Requires: NODE_USE_ENV_PROXY=1 when behind a proxy. Builds the same requirements the
// Worker builds and verifies an unfunded wallet against the real public facilitator.
// Expected: initialize ok, amount 10000 on USDC, verify fails with insufficient balance.
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const NETWORK = "eip155:84532";
const client = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const server = new x402ResourceServer(client).register(NETWORK, new ExactEvmScheme());
const t0 = Date.now();
await server.initialize();
console.log("initialize ok in ms:", Date.now() - t0);
const reqs = await server.buildPaymentRequirementsFromOptions(
  [{ scheme: "exact", payTo: "0x0000000000000000000000000000000000000001", price: "$0.01", network: NETWORK, maxTimeoutSeconds: 600 }],
  { resourceUrl: "https://api.example.com/v1/items" },
);
console.log("requirements:", JSON.stringify(reqs[0]));
const required = await server.createPaymentRequiredResponse(reqs, { url: "https://api.example.com/v1/items", description: "Store an item" });
const account = privateKeyToAccount(generatePrivateKey());
const c = new x402Client();
registerExactEvmScheme(c, { signer: account });
const payload = await c.createPaymentPayload(required);
const matched = server.findMatchingRequirements(required.accepts, payload);
console.log("matched:", !!matched);
const t1 = Date.now();
const v = await server.verifyPayment(payload, matched);
console.log("verify (unfunded wallet) in ms:", Date.now() - t1, JSON.stringify(v));
