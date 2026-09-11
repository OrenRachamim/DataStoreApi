# Deploying to testnet (runbook)

This is written for a fresh Claude Code session that has `CLOUDFLARE_API_TOKEN` in its
environment and no memory of earlier sessions. Follow it top to bottom. The account id is
already in `wrangler.jsonc`.

## 0. Preconditions

```bash
npm install
npx wrangler whoami          # must show the account, no login prompt
npm test                     # 175 tests must pass before deploying
```

## 1. Decide the receiving wallet (`PAY_TO`)

The USDC of every paid call goes to this address on Base Sepolia. If the user provided one,
use it. Otherwise generate a throwaway one and print both values for the user, never commit
them:

```bash
node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const k=generatePrivateKey();console.log('PAY_TO_ADDRESS='+privateKeyToAccount(k).address);console.log('PAY_TO_PRIVATE_KEY='+k)"
```

## 2. Bucket and secrets

Both Workers (API host and share host) must share the same secrets: links signed by one are
verified by the other.

```bash
npx wrangler r2 bucket create datastore-items-testnet
HMAC=$(openssl rand -hex 32); IDEM=$(openssl rand -hex 32); SALT=$(openssl rand -hex 16)
for ENV in testnet testnet-share; do
  printf %s "$HMAC" | npx wrangler secret put HMAC_KEY --env $ENV
  printf %s "$IDEM" | npx wrangler secret put IDEM_KEY --env $ENV
  printf %s "$SALT" | npx wrangler secret put IP_SALT --env $ENV
done
```

If `secret put` fails because the Worker does not exist yet, deploy once first (step 3)
and then put the secrets and deploy again.

## 3. Deploy twice on workers.dev (no custom domains needed)

The Worker decides by host which routes it serves, so the API and the share domain are
two deployments of the same code with the same bucket. The workers.dev hostnames are
`https://datastore-api-testnet.<subdomain>.workers.dev` and
`https://datastore-share-testnet.<subdomain>.workers.dev`. Find `<subdomain>` with:

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts/$(node -p "require('./wrangler.jsonc').account_id" 2>/dev/null || echo ccda1018431c9d935588b68f06478ba9)/workers/subdomain
```

Then deploy with the origins passed as vars (do not edit the placeholders in wrangler.jsonc):

```bash
API=https://datastore-api-testnet.<subdomain>.workers.dev
DL=https://datastore-share-testnet.<subdomain>.workers.dev
PAY_TO=0x...
npx wrangler deploy --env testnet       --var API_ORIGIN:$API --var DL_ORIGIN:$DL --var PAY_TO:$PAY_TO
npx wrangler deploy --env testnet-share --var API_ORIGIN:$API --var DL_ORIGIN:$DL --var PAY_TO:$PAY_TO
```

If a workers.dev route is disabled for the account, enable it in the dashboard under the
Worker's Settings, Domains & Routes.

## 4. Smoke checks (no funds needed)

```bash
curl -s $API/v1/pricing
curl -s $API/llms.txt | head -20
curl -s -i -X POST -H 'Content-Type: application/json' -d '{"a":1}' "$API/v1/items?ttl_days=1" | head -20   # expect 402 + PAYMENT-REQUIRED header
curl -s -i $DL/d/itm_xxxxxxxxxxxxxxxxxxxxxx | head -5                                                  # expect 404 JSON
NODE_USE_ENV_PROXY=1 node scripts/facilitator-check.mjs                                                 # expect insufficient balance from verify
```

## 5. End to end with real testnet USDC

1. Generate an E2E wallet (same command as step 1) and fund it with Base Sepolia USDC from
   https://faucet.circle.com (select Base Sepolia). A few USDC covers hundreds of calls.
   No ETH is needed; the facilitator pays gas.
2. Run:

```bash
API=$API E2E_PRIVATE_KEY=0x... NODE_USE_ENV_PROXY=1 node scripts/e2e.mjs
```

Every step prints PASS or FAIL with the transaction hash. Check one hash on
https://sepolia.basescan.org and confirm 0.01 USDC moved to `PAY_TO`.

3. Optional browser check of the sandbox (TESTS.md DL-03): upload
   `scripts/sandbox-probe.html`, create a link, and run `scripts/browser-sandbox-check.mjs`.

## 6. Record the results

Append the outcome to the "Live checks" table in `TESTS.md`, commit and push. The
cron sweep runs at 01:15 UTC; after three days check the Worker logs for `expiry_sweep`.

## Production later

Same steps with `--env production`, a real `PAY_TO`, two custom domains routed to the
Worker, and the CDP secrets `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` for the mainnet
facilitator. Set up Logpush for the payment log before the first real customer.
