import type { Hono } from "hono";
import type { AppContext } from "../app";
import { hmacHex } from "../ids";
import { logEvent } from "../log";
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN } from "../password";
import { updateMeta, type Meta } from "../store";
import { invalid, loadOwnedItem } from "./items";
import type { Config } from "../env";

export async function linkSignature(config: Config, id: string, exp: number, gen: number): Promise<string> {
  return hmacHex(config.hmacKey, `${id}|${exp}|${gen}`);
}

export async function buildSignedLink(config: Config, meta: Meta, expiresAtMs: number): Promise<{ url: string; expires_at: string }> {
  const exp = Math.floor(expiresAtMs / 1000);
  const sig = await linkSignature(config, meta.id, exp, meta.generation);
  const u = new URL(`${config.dlOrigin}/d/${meta.id}`);
  u.searchParams.set("exp", String(exp));
  u.searchParams.set("gen", String(meta.generation));
  u.searchParams.set("sig", sig);
  return { url: u.toString(), expires_at: new Date(exp * 1000).toISOString() };
}

export function shareRoutes(app: Hono<AppContext>): void {
  app.post("/v1/items/:id/links", async (c) => {
    const cfg = c.get("config");
    const cur = await loadOwnedItem(c, c.req.param("id") as string);
    let body: { expires_in?: unknown };
    try {
      body = (await c.req.json()) as { expires_in?: unknown };
    } catch {
      throw invalid('Body must be JSON like {"expires_in": 3600}.');
    }
    const secs = body?.expires_in;
    if (typeof secs !== "number" || !Number.isInteger(secs) || secs < 1) throw invalid("expires_in must be a positive integer number of seconds.");
    // Clamp to the item's own expiry: a link cannot outlive its item.
    const wanted = Date.now() + secs * 1000;
    const clamped = Math.min(wanted, Date.parse(cur.meta.expiresAt));
    const link = await buildSignedLink(cfg, cur.meta, clamped);
    return c.json({ ...link, clamped_to_item_expiry: clamped !== wanted });
  });

  app.post("/v1/items/:id/links/revoke", async (c) => {
    const cur = await loadOwnedItem(c, c.req.param("id") as string);
    await updateMeta(c.env.BUCKET, cur.meta.id, (m) => {
      m.generation += 1;
    });
    logEvent("system", { event: "links_revoked", item_id: cur.meta.id });
    return c.body(null, 204);
  });

  app.put("/v1/items/:id/password", async (c) => {
    const cur = await loadOwnedItem(c, c.req.param("id") as string);
    let body: { password?: unknown };
    try {
      body = (await c.req.json()) as { password?: unknown };
    } catch {
      throw invalid('Body must be JSON like {"password": "..."}.');
    }
    const pw = body?.password;
    if (typeof pw !== "string" || pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
      throw invalid(`password must be a string of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    }
    const hashed = await hashPassword(pw);
    await updateMeta(c.env.BUCKET, cur.meta.id, (m) => {
      m.password = hashed;
      delete m.lock;
    });
    return c.body(null, 204);
  });

  app.delete("/v1/items/:id/password", async (c) => {
    const cur = await loadOwnedItem(c, c.req.param("id") as string);
    await updateMeta(c.env.BUCKET, cur.meta.id, (m) => {
      delete m.password;
      delete m.lock;
    });
    return c.body(null, 204);
  });
}
