import { Hono } from "hono";
import type { Env } from "./env";
import { configFromEnv, type Config } from "./env";
import { ApiError, errorBody } from "./errors";
import { newRequestId } from "./ids";
import { hashIp, logEvent } from "./log";
import { createPaymentService, type PaymentService } from "./payment";
import { docsRoutes } from "./routes/docs";
import { itemRoutes } from "./routes/items";

export type Variables = {
  config: Config;
  payments: PaymentService;
  requestId: string;
  logFields: Record<string, unknown>;
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
    c.set("payments", createPaymentService(config));
    c.set("logFields", {});
    c.header("X-Request-Id", requestId);
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

  // Method not allowed for known collection paths.
  app.all("/v1/items", (c) => {
    throw new ApiError(405, "method_not_allowed", "Use POST to upload an item.", { description: "POST the content to this URL.", method: "POST", url: `${c.get("config").apiOrigin}/v1/items` }, undefined, { Allow: "POST" });
  });

  return app;
}
