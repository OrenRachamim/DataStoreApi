# DataStore API

Storage for AI agents: JSON or files, no account, every paid call is $0.01 USDC via x402.

- Design: [DESIGN.md](DESIGN.md)
- Test plan: [TESTS.md](TESTS.md)

## Development

```bash
npm install
npm test          # unit + integration on workerd with a local R2 bucket
npm run typecheck
npm run dev       # wrangler dev on http://localhost:8787
```

Tests run inside the Workers runtime through `@cloudflare/vitest-pool-workers`. The
facilitator is mocked in `test/helpers.ts` with real EIP-3009 signature checks; payments in
tests are produced by the official `@x402/fetch` client with a throwaway wallet.

## Configuration

Variables live in `wrangler.jsonc` (`vars`). Secrets are set with `wrangler secret put`:

| Secret | Purpose |
|---|---|
| `HMAC_KEY` | Signs share links |
| `IDEM_KEY` | Encrypts secrets inside idempotency records |
| `IP_SALT` | Daily-rotating salt for hashed IPs in logs |

`PAY_TO` must be the wallet that receives USDC. `NETWORK` is `eip155:84532` (Base Sepolia,
testnet) or `eip155:8453` (Base mainnet).

## Deployment

Two Workers environments are defined in `wrangler.jsonc`:

| Environment | Network | Facilitator | Limits |
|---|---|---|---|
| `testnet` | Base Sepolia (`eip155:84532`) | `https://x402.org/facilitator`, no auth | 1 MB, 7 days |
| `production` | Base mainnet (`eip155:8453`) | Coinbase CDP, needs `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` secrets | 25 MB, 365 days |

Before the first deploy, edit the `vars` of the environment: `PAY_TO` (the wallet that
receives USDC), `API_ORIGIN` and `DL_ORIGIN` (two separate domains; the share domain must
not be a subdomain of the brand). Then:

```bash
wrangler r2 bucket create datastore-items-testnet
wrangler secret put HMAC_KEY --env testnet
wrangler secret put IDEM_KEY --env testnet
wrangler secret put IP_SALT --env testnet
wrangler deploy --env testnet
```

Route both domains to the same Worker (custom domains in the Cloudflare dashboard). The
Worker decides by host which routes it serves. The cron trigger runs the expiry sweep at
01:15 UTC. Set up Logpush from Workers Logs to an `audit/` R2 bucket filtered on
`"kind":"payment"` for the seven-year payment record.

## Live checks

```bash
# Real facilitator wiring (no funds needed; expects "insufficient balance" from verify)
NODE_USE_ENV_PROXY=1 node scripts/facilitator-check.mjs

# Browser sandbox check for HTML items (see the script header)
LINK=... CHROME=... npx -p playwright-core node scripts/browser-sandbox-check.mjs
```
