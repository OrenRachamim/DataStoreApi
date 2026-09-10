import type { Context, Hono } from "hono";
import type { AppContext } from "../app";
import { ApiError, notFound } from "../errors";
import { ITEM_ID_RE, timingSafeEqual } from "../ids";
import { isExpired } from "../items";
import { checkLimit, clientIp } from "../limits";
import { logEvent } from "../log";
import { verifyPassword } from "../password";
import { readMeta, updateMeta, type Meta } from "../store";
import { serveContent } from "./items";
import { linkSignature } from "./share";

type Ctx = Context<AppContext>;

const LOCK_FAILURES = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const IP_LIMIT = { limit: 30, periodSeconds: 60 };

function wantsHtml(c: Ctx): boolean {
  const accept = c.req.header("accept") ?? "";
  return /text\/html/i.test(accept);
}

function baseHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
}

function passwordPage(c: Ctx, id: string, message?: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Password required</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.25rem 0}.err{color:#b00}</style></head>
<body><h1>This file is password protected</h1>${message ? `<p class="err">${message}</p>` : ""}
<form method="post" action="/d/${id}"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="off" minlength="12" maxlength="128" required><button type="submit">Download</button></form>
</body></html>`;
  return c.html(html, 200, {
    ...baseHeaders(),
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
}

function readsGonePage(c: Ctx): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>No reads left</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto"><h1>This link has no reads left</h1><p>Ask whoever shared it with you to add more reads.</p></body></html>`;
  return c.html(html, 402, { ...baseHeaders(), "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
}

export function dlRoutes(app: Hono<AppContext>): void {
  app.get("/d/:id", handleDownload);
  app.post("/d/:id", handleDownload);
}

async function handleDownload(c: Ctx): Promise<Response> {
  const cfg = c.get("config");
  const id = c.req.param("id") as string;
  if (!ITEM_ID_RE.test(id)) throw notFound();
  const cur = await readMeta(c.env.BUCKET, id);
  if (!cur || isExpired(cur.meta)) throw notFound();
  const meta = cur.meta;
  c.get("logFields").item_id = id;

  // Signed link: HMAC over id, expiry and generation. Bypasses the password.
  const sig = c.req.query("sig");
  if (c.req.method === "GET" && sig) {
    const exp = Number.parseInt(c.req.query("exp") ?? "", 10);
    const gen = Number.parseInt(c.req.query("gen") ?? "", 10);
    if (!Number.isFinite(exp) || !Number.isFinite(gen)) throw notFound();
    const expected = await linkSignature(cfg, id, exp, gen);
    if (!timingSafeEqual(expected, sig) || gen !== meta.generation || exp * 1000 <= Date.now()) throw notFound();
    c.get("logFields").access = "signed_link";
    return serveContent(c, meta, "dl");
  }

  // Password path.
  if (!meta.password) throw notFound();
  let supplied: string | undefined;
  if (c.req.method === "POST") {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const v = (form as Record<string, unknown>).password;
    supplied = typeof v === "string" ? v : undefined;
  } else {
    supplied = c.req.header("x-password") ?? undefined;
  }
  if (supplied === undefined) {
    if (wantsHtml(c)) return passwordPage(c, id);
    throw notFound();
  }

  const ip = clientIp(c.req.raw);
  const allowed = await checkLimit(c.env.PASSWORD_LIMITER, "password", ip, IP_LIMIT);
  if (!allowed) {
    logEvent("system", { event: "password_rate_limited", item_id: id });
    throw new ApiError(429, "rate_limited", "Too many password attempts from this address.", { description: "Wait a minute and retry." }, undefined, { "Retry-After": "60", "RateLimit-Limit": String(IP_LIMIT.limit), "RateLimit-Remaining": "0" });
  }

  const now = Date.now();
  if (meta.lock?.lockedUntil && Date.parse(meta.lock.lockedUntil) > now) {
    const retry = Math.ceil((Date.parse(meta.lock.lockedUntil) - now) / 1000);
    throw new ApiError(423, "locked", "Too many wrong passwords. This item is temporarily locked.", { description: `Wait ${retry} seconds and retry.` }, undefined, { "Retry-After": String(retry) });
  }

  const ok = await verifyPassword(supplied, meta.password);
  if (!ok) {
    await updateMeta(c.env.BUCKET, id, (m) => {
      const first = m.lock?.firstFailAt ? Date.parse(m.lock.firstFailAt) : 0;
      const inWindow = m.lock && now - first < LOCK_WINDOW_MS;
      const failures = (inWindow ? m.lock!.failures : 0) + 1;
      m.lock = { failures, firstFailAt: inWindow ? m.lock!.firstFailAt : new Date(now).toISOString() };
      if (failures >= LOCK_FAILURES) {
        m.lock.lockedUntil = new Date(now + LOCK_DURATION_MS).toISOString();
        logEvent("system", { event: "password_locked", item_id: id });
      }
    });
    c.get("logFields").access = "password_failed";
    if (wantsHtml(c) && c.req.method === "POST") return passwordPage(c, id, "Wrong password.");
    throw notFound();
  }
  if (meta.lock) {
    await updateMeta(c.env.BUCKET, id, (m) => {
      delete m.lock;
    });
  }
  c.get("logFields").access = "password";
  if (meta.readsRemaining <= 0 && wantsHtml(c)) return readsGonePage(c);
  return serveContent(c, meta as Meta, "dl");
}
