import { Hono } from "hono";
import type { Env } from "./env";
import { configFromEnv, type Config } from "./env";
import { ApiError, errorBody } from "./errors";
import { newRequestId } from "./ids";
import { hashIp, logEvent } from "./log";
import { createPaymentService, type PaymentService } from "./payment";
import { docsRoutes } from "./routes/docs";
import { itemRoutes } from "./routes/items";
import { shareRoutes } from "./routes/share";
import { dlRoutes } from "./routes/dl";
import { feedbackRoutes } from "./routes/feedback";
import { checkLimit, clientIp } from "./limits";

export type Variables = {
  config: Config;
  payments: PaymentService;
  requestId: string;
  logFields: Record<string, unknown>;
  /** True when the request arrived on the share (download) domain. */
  isDl: boolean;
};

export type AppContext = { Bindings: Env; Variables: Variables };

export function createApp() {
  const app = new Hono<AppContext>();

  app.use("*", async (c, next) => {
    const started = Date.now();
    const requestId = newRequestId();
    const config = configFromEnv(c.env);
    c.set("requestId", requestId);
    c.set("config", config);
    c.set("payments", createPaymentService(config, { apiKeyId: c.env.CDP_API_KEY_ID, apiKeySecret: c.env.CDP_API_KEY_SECRET }));
    c.set("logFields", {});
    const reqUrl = new URL(c.req.url);
    const isDl = reqUrl.host === new URL(config.dlOrigin).host && reqUrl.host !== new URL(config.apiOrigin).host;
    c.set("isDl", isDl);
    c.header("X-Request-Id", requestId);
    // Each domain answers only its own routes (DESIGN.md 4, DL-08).
    const isDlPath = reqUrl.pathname.startsWith("/d/");
    if (isDl !== isDlPath) {
      throw new ApiError(404, "not_found", "No such route on this host.", { description: "API routes live on the API origin; share links on the share origin.", method: "GET", url: `${config.apiOrigin}/llms.txt` });
    }
    // General per-address limit: generous, and only a backstop against runaway loops.
    if (!(await checkLimit(c.env.API_LIMITER, "api", clientIp(c.req.raw), { limit: 600, periodSeconds: 60 }))) {
      throw new ApiError(429, "rate_limited", "Too many requests from this address.", { description: "Slow down and retry after the indicated delay." }, undefined, { "Retry-After": "60", "RateLimit-Limit": "600", "RateLimit-Remaining": "0" });
    }
    await next();
    c.header("X-Request-Id", requestId);
    const url = new URL(c.req.url);
    logEvent("request", {
      request_id: requestId,
      method: c.req.method,
      path: url.pathname,
      status: c.res.status,
      duration_ms: Date.now() - started,
      country: (c.req.raw.cf as { country?: string } | undefined)?.country,
      ip_hash: await hashIp(c.req.header("cf-connecting-ip"), config.ipSalt),
      ...c.get("logFields"),
    });
  });

  app.onError((err, c) => {
    const config = c.get("config") ?? configFromEnv(c.env);
    const requestId = c.get("requestId") ?? "req_unknown";
    if (err instanceof ApiError) {
      const body = errorBody(err, requestId, config.apiOrigin);
      const headers = new Headers({ "Content-Type": "application/json", "X-Request-Id": requestId, ...(err.headers ?? {}) });
      return new Response(JSON.stringify(body), { status: err.status, headers });
    }
    logEvent("system", { event: "unhandled_error", request_id: requestId, error: String(err?.message ?? err) });
    const internal = new ApiError(500, "internal_error", "Something went wrong on our side. Retry with the same idempotency key; if it persists, send feedback with the request id.");
    return new Response(JSON.stringify(errorBody(internal, requestId, config.apiOrigin)), {
      status: 500,
      headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
    });
  });

  app.notFound((c) => {
    throw new ApiError(404, "not_found", `No route for ${c.req.method} ${new URL(c.req.url).pathname}.`, {
      description: "See the API description.",
      method: "GET",
      url: `${c.get("config").apiOrigin}/llms.txt`,
    });
  });

  docsRoutes(app);
  itemRoutes(app);
  shareRoutes(app);
  dlRoutes(app);
  feedbackRoutes(app);

  // Method not allowed for known collection paths.
  app.all("/v1/items", (c) => {
    throw new ApiError(405, "method_not_allowed", "Use POST to upload an item.", { description: "POST the content to this URL.", method: "POST", url: `${c.get("config").apiOrigin}/v1/items` }, undefined, { Allow: "POST" });
  });

  return app;
}
