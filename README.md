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
