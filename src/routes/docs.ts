import type { Hono } from "hono";
import type { AppContext } from "../app";
import { ALLOWED_TYPES } from "../content";
import type { Config } from "../env";
import { networkName } from "../items";

export function pricing(config: Config) {
  return {
    upload: config.priceUsd,
    extend: config.priceUsd,
    reads_1000: config.priceUsd,
    currency: "USDC",
    network: networkName(config.network),
    max_bytes: config.maxBytes,
    max_ttl_days: config.maxTtlDays,
    default_ttl_days: config.defaultTtlDays,
    included_reads: config.includedReads,
    read_pack_size: config.readPackSize,
    allowed_content_types: [...ALLOWED_TYPES],
    protocol: "x402",
  };
}

export function docsRoutes(app: Hono<AppContext>): void {
  app.get("/v1/pricing", (c) => c.json(pricing(c.get("config"))));

  app.get("/llms.txt", (c) => {
    const cfg = c.get("config");
    const o = cfg.apiOrigin;
    const text = `# ${cfg.serviceName}

Store JSON or files for AI agents. No account, no API key. Every paid call is
$${cfg.priceUsd} USDC on ${networkName(cfg.network)} via the x402 protocol (HTTP 402).
Use an x402 client (for example @x402/fetch for TypeScript, or the x402 Python
package) with a wallet that holds USDC, and every 402 is handled for you.

## Prices and limits
- Upload (JSON or file, up to ${cfg.maxBytes} bytes, kept 1 to ${cfg.maxTtlDays} days, includes ${cfg.includedReads} reads): $${cfg.priceUsd}
- Extend expiry (up to ${cfg.maxTtlDays} days from now): $${cfg.priceUsd}
- ${cfg.readPackSize} extra reads for one item: $${cfg.priceUsd}
- Everything else is free. Early delete gives no refund.
- Allowed content: ${ALLOWED_TYPES.join(", ")}. Type is detected from the content.

## Store
POST ${o}/v1/items?ttl_days=7&label=my-result
Body: the raw content. Content-Type is optional.
Response 201: {"id","secret","expires_at","reads_remaining","links":{...}}
Keep the secret. It is shown once and cannot be recovered.

## Retrieve
GET ${o}/v1/items/{id}
Authorization: Bearer {secret}
JSON comes back inline; files come back as attachments. Each read counts.
When reads run out you get 402; paying on the same request adds ${cfg.readPackSize} reads and returns the content.

## Status (free, does not count as a read)
GET ${o}/v1/items/{id}/status  (Bearer secret)

## Extend
POST ${o}/v1/items/{id}/extend  (Bearer secret)  {"ttl_days": 30}

## Buy reads in advance (no secret needed; do this before sharing with a human)
POST ${o}/v1/items/{id}/reads

## Delete
DELETE ${o}/v1/items/{id}  (Bearer secret)

## Errors
Every error is JSON with "error", "message", "action" (what to do next, with a URL),
"request_id" and "feedback". 404 covers not found, expired and wrong credentials alike.

## Tools
${o}/tools.json has function-calling definitions. ${o}/openapi.json is the full spec.
Missing something? POST ${o}/v1/feedback {"type":"missing","message":"..."}
Terms: ${o}/terms
`;
    return c.text(text);
  });

  app.get("/tools.json", (c) => {
    const cfg = c.get("config");
    const o = cfg.apiOrigin;
    const tools = [
      {
        name: "store",
        description: `Store JSON or a file for later retrieval. Costs $${cfg.priceUsd} USDC via x402. Returns an id and a one-time secret.`,
        endpoint: { method: "POST", url: `${o}/v1/items` },
        input_schema: {
          type: "object",
          properties: {
            content: { type: "string", description: "The raw content to store (JSON text or file bytes)." },
            content_type: { type: "string", description: "Optional MIME type. Detected from content when omitted." },
            ttl_days: { type: "integer", minimum: 1, maximum: cfg.maxTtlDays, default: cfg.defaultTtlDays },
            label: { type: "string", maxLength: cfg.maxLabelLength, description: "Optional label to recognise the item later." },
          },
          required: ["content"],
        },
      },
      {
        name: "retrieve",
        description: "Retrieve the full content of a stored item. Counts one read.",
        endpoint: { method: "GET", url: `${o}/v1/items/{id}`, auth: "Bearer {secret}" },
        input_schema: { type: "object", properties: { id: { type: "string" }, secret: { type: "string" } }, required: ["id", "secret"] },
      },
      {
        name: "status",
        description: "Get expiry, remaining reads, size and type of an item. Free.",
        endpoint: { method: "GET", url: `${o}/v1/items/{id}/status`, auth: "Bearer {secret}" },
        input_schema: { type: "object", properties: { id: { type: "string" }, secret: { type: "string" } }, required: ["id", "secret"] },
      },
      {
        name: "extend",
        description: `Set a new expiry, up to ${cfg.maxTtlDays} days from now. Costs $${cfg.priceUsd}.`,
        endpoint: { method: "POST", url: `${o}/v1/items/{id}/extend`, auth: "Bearer {secret}" },
        input_schema: { type: "object", properties: { id: { type: "string" }, secret: { type: "string" }, ttl_days: { type: "integer", minimum: 1, maximum: cfg.maxTtlDays } }, required: ["id", "secret", "ttl_days"] },
      },
      {
        name: "share_link",
        description: "Create a time-limited link that lets anyone read the item without the secret.",
        endpoint: { method: "POST", url: `${o}/v1/items/{id}/links`, auth: "Bearer {secret}" },
        input_schema: { type: "object", properties: { id: { type: "string" }, secret: { type: "string" }, expires_in: { type: "integer", description: "Seconds" } }, required: ["id", "secret", "expires_in"] },
      },
      {
        name: "delete",
        description: "Delete an item now. No refund.",
        endpoint: { method: "DELETE", url: `${o}/v1/items/{id}`, auth: "Bearer {secret}" },
        input_schema: { type: "object", properties: { id: { type: "string" }, secret: { type: "string" } }, required: ["id", "secret"] },
      },
      {
        name: "feedback",
        description: "Tell the service what is missing or broken. Free.",
        endpoint: { method: "POST", url: `${o}/v1/feedback` },
        input_schema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["missing", "bug", "abuse", "other"] },
            message: { type: "string", maxLength: 2000 },
            item_id: { type: "string" },
            request_id: { type: "string" },
          },
          required: ["type", "message"],
        },
      },
    ];
    return c.json({ service: cfg.serviceName, tools });
  });

  app.get("/openapi.json", (c) => c.json(openapi(c.get("config"))));

  app.get("/terms", (c) =>
    c.text(
      `${c.get("config").serviceName} - Terms of Service and Privacy (draft)\n\n` +
        `1. You own the content you store. We hold a limited licence to store and serve it.\n` +
        `2. Payment via x402 constitutes acceptance of these terms.\n` +
        `3. Content expires at the time you chose and is then deleted. No refunds for early deletion.\n` +
        `4. Secrets and passwords cannot be recovered.\n` +
        `5. We may remove content that violates these terms and may keep payment records for accounting.\n` +
        `6. We log request metadata (hashed IP for 7 days, payment records for 7 years) and never the content.\n` +
        `7. Report abuse: POST /v1/feedback with type "abuse" and the item id.\n`,
    ),
  );
}

function openapi(cfg: Config) {
  const o = cfg.apiOrigin;
  const bearer = [{ bearer: [] }];
  const item = { $ref: "#/components/schemas/Item" };
  const err = (code: string) => ({ description: code, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
  return {
    openapi: "3.1.0",
    info: { title: cfg.serviceName, version: "1.0.0", description: `Storage for AI agents, paid per operation with x402. Price: $${cfg.priceUsd} USDC per paid call.` },
    servers: [{ url: o }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "The item secret returned at upload." } },
      schemas: {
        Item: {
          type: "object",
          properties: {
            id: { type: "string" },
            secret: { type: "string", description: "Only in the upload response." },
            label: { type: "string" },
            content_type: { type: "string" },
            size: { type: "integer" },
            created_at: { type: "string", format: "date-time" },
            expires_at: { type: "string", format: "date-time" },
            reads_remaining: { type: "integer" },
            has_password: { type: "boolean" },
            links: { type: "object", additionalProperties: { type: "string", format: "uri" } },
            payment: { type: "object", properties: { amount: { type: "string" }, currency: { type: "string" }, network: { type: "string" }, tx: { type: "string" } } },
          },
          required: ["id", "content_type", "size", "created_at", "expires_at", "reads_remaining", "has_password", "links"],
        },
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            message: { type: "string" },
            action: { type: "object", properties: { description: { type: "string" }, method: { type: "string" }, url: { type: "string" } } },
            request_id: { type: "string" },
            docs: { type: "string" },
            feedback: { type: "string" },
          },
          required: ["error", "message", "request_id"],
        },
      },
    },
    paths: {
      "/v1/pricing": { get: { summary: "Prices and limits", responses: { "200": { description: "OK" } } } },
      "/llms.txt": { get: { summary: "Service description for agents", responses: { "200": { description: "OK" } } } },
      "/tools.json": { get: { summary: "Function-calling tool definitions", responses: { "200": { description: "OK" } } } },
      "/terms": { get: { summary: "Terms and privacy", responses: { "200": { description: "OK" } } } },
      "/v1/items": {
        post: {
          summary: "Upload JSON or a file (paid)",
          parameters: [
            { name: "ttl_days", in: "query", schema: { type: "integer", minimum: 1, maximum: cfg.maxTtlDays, default: cfg.defaultTtlDays } },
            { name: "label", in: "query", schema: { type: "string", maxLength: cfg.maxLabelLength } },
            { name: "Idempotency-Key", in: "header", schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "*/*": { schema: { type: "string", format: "binary" } } } },
          responses: { "201": { description: "Stored", content: { "application/json": { schema: item } } }, "400": err("invalid_request"), "402": err("payment_required"), "409": err("idempotency_conflict"), "413": err("too_large"), "415": err("unsupported_type") },
        },
      },
      "/v1/items/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Retrieve content (counts one read)", security: bearer, responses: { "200": { description: "Content" }, "402": err("reads_exhausted"), "404": err("not_found") } },
        delete: { summary: "Delete now", security: bearer, responses: { "204": { description: "Deleted" }, "404": err("not_found") } },
      },
      "/v1/items/{id}/status": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Status (free)", security: bearer, responses: { "200": { description: "OK", content: { "application/json": { schema: item } } }, "404": err("not_found") } },
      },
      "/v1/items/{id}/extend": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Set a new expiry (paid)", security: bearer, requestBody: { content: { "application/json": { schema: { type: "object", properties: { ttl_days: { type: "integer" } }, required: ["ttl_days"] } } } }, responses: { "200": { description: "OK", content: { "application/json": { schema: item } } }, "400": err("invalid_request"), "402": err("payment_required"), "404": err("not_found") } },
      },
      "/v1/items/{id}/reads": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: `Add ${cfg.readPackSize} reads (paid, no secret needed)`, responses: { "200": { description: "OK", content: { "application/json": { schema: item } } }, "402": err("payment_required"), "404": err("not_found") } },
      },
      "/v1/items/{id}/links": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Create a signed share link", security: bearer, requestBody: { content: { "application/json": { schema: { type: "object", properties: { expires_in: { type: "integer" } }, required: ["expires_in"] } } } }, responses: { "200": { description: "OK" }, "404": err("not_found") } },
      },
      "/v1/items/{id}/links/revoke": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Revoke all share links", security: bearer, responses: { "204": { description: "Revoked" }, "404": err("not_found") } },
      },
      "/v1/items/{id}/password": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        put: { summary: "Set or replace the share password", security: bearer, requestBody: { content: { "application/json": { schema: { type: "object", properties: { password: { type: "string", minLength: 12, maxLength: 128 } }, required: ["password"] } } } }, responses: { "204": { description: "Set" }, "400": err("invalid_request"), "404": err("not_found") } },
        delete: { summary: "Remove the share password", security: bearer, responses: { "204": { description: "Removed" }, "404": err("not_found") } },
      },
      "/v1/feedback": {
        post: { summary: "Send feedback or report abuse (free)", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { type: { type: "string", enum: ["missing", "bug", "abuse", "other"] }, message: { type: "string", maxLength: 2000 }, item_id: { type: "string" }, request_id: { type: "string" } }, required: ["type", "message"] } } } }, responses: { "202": { description: "Accepted" }, "400": err("invalid_request"), "429": err("rate_limited") } },
      },
    },
  };
}
