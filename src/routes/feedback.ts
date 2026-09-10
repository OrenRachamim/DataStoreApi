import type { Hono } from "hono";
import type { AppContext } from "../app";
import { ApiError } from "../errors";
import { base64url, randomBytes } from "../ids";
import { clientIp } from "../limits";
import { hashIp, logEvent } from "../log";
import { dateKey, KEYS } from "../store";
import { invalid } from "./items";

const TYPES = ["missing", "bug", "abuse", "other"] as const;
type FeedbackType = (typeof TYPES)[number];
const MAX_MESSAGE = 2000;
const PER_HOUR = 5;
const RETENTION_DAYS = 90;

interface FeedbackRecord {
  id: string;
  type: FeedbackType;
  message: string;
  item_id?: string;
  request_id?: string;
  ip_hash: string;
  created_at: string;
}

export function feedbackRoutes(app: Hono<AppContext>): void {
  app.post("/v1/feedback", async (c) => {
    const cfg = c.get("config");
    const bucket = c.env.BUCKET;
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw invalid('Body must be JSON like {"type": "missing", "message": "..."}.');
    }
    const type = body.type;
    if (typeof type !== "string" || !(TYPES as readonly string[]).includes(type)) throw invalid(`type must be one of ${TYPES.join(", ")}.`);
    const message = body.message;
    if (typeof message !== "string" || message.trim().length === 0) throw invalid("message must be a non-empty string.");
    if (message.length > MAX_MESSAGE) throw invalid(`message must be at most ${MAX_MESSAGE} characters.`);
    const itemId = body.item_id;
    if (itemId !== undefined && typeof itemId !== "string") throw invalid("item_id must be a string.");
    if (type === "abuse" && !itemId) throw invalid("item_id is required for abuse reports.");
    const requestId = body.request_id;
    if (requestId !== undefined && typeof requestId !== "string") throw invalid("request_id must be a string.");

    // Five reports per hour per address. A small R2 counter keeps it global
    // without a database; a lost increment under concurrency is acceptable.
    const ipHash = await hashIp(clientIp(c.req.raw), cfg.ipSalt);
    const hour = new Date().toISOString().slice(0, 13);
    const counterKey = `ratelimit/feedback/${ipHash}/${hour}`;
    const counterObj = await bucket.get(counterKey);
    const count = counterObj ? Number.parseInt(await counterObj.text(), 10) || 0 : 0;
    if (count >= PER_HOUR) {
      throw new ApiError(429, "rate_limited", "Too many feedback reports from this address this hour.", { description: "Wait and try again later." }, undefined, { "Retry-After": "3600", "RateLimit-Limit": String(PER_HOUR), "RateLimit-Remaining": "0" });
    }
    await bucket.put(counterKey, String(count + 1));

    const now = new Date();
    const id = "fb_" + base64url(randomBytes(12));
    const record: FeedbackRecord = {
      id,
      type: type as FeedbackType,
      message: message.trim(),
      ...(itemId ? { item_id: itemId as string } : {}),
      ...(requestId ? { request_id: requestId as string } : {}),
      ip_hash: ipHash,
      created_at: now.toISOString(),
    };
    // Abuse reports sort first within the day and are kept with their decision.
    const name = type === "abuse" ? `abuse_${id}` : id;
    const key = KEYS.feedback(dateKey(now.toISOString()), name);
    await bucket.put(key, JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
    if (type !== "abuse") {
      const expires = new Date(now.getTime() + RETENTION_DAYS * 86_400_000).toISOString();
      await bucket.put(`${KEYS.expiryPrefix(dateKey(expires))}fb~${key.replace(/\//g, "~")}`, "");
    }
    logEvent("system", { event: "feedback", feedback_id: id, type, item_id: itemId, priority: type === "abuse" });
    return c.json({ id, received: true }, 202);
  });
}
