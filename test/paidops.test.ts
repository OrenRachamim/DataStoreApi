import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { API, auth, bucket, expectError, facilitator, get, listKeys, makeItem, payingFetch, rawFetch, resetAll, settle, signedHeaderFor, status } from "./helpers";
import { fixtures } from "./fixtures";

beforeEach(resetAll);
afterEach(() => vi.restoreAllMocks());

async function meta(id: string): Promise<Record<string, any>> {
  return JSON.parse(await (await bucket().get(`meta/${id}`))!.text());
}

const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

describe("extend (EXT)", () => {
  it("EXT-01 unpaid extend is an x402 402 with a 60 second window", async () => {
    const it = await makeItem();
    const res = await rawFetch(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 30 }) });
    const err = await expectError(res, 402, "payment_required");
    expect((err.x402 as { accepts: Array<{ maxTimeoutSeconds: number }> }).accepts[0].maxTimeoutSeconds).toBe(60);
  });

  it("EXT-02 a paid extension moves the expiry and the marker", async () => {
    const it = await makeItem({ ttlDays: 7 });
    const oldDay = (it.body.expires_at as string).slice(0, 10);
    const res = await payingFetch()(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 30 }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(days(body.expires_at, new Date().toISOString())).toBe(30);
    expect(body.payment).toMatchObject({ amount: "0.01", currency: "USDC" });
    expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!).success).toBe(true);
    const newDay = body.expires_at.slice(0, 10);
    expect(await listKeys(`expiry/${newDay}/${it.id}`)).toHaveLength(1);
    expect(await listKeys(`expiry/${oldDay}/${it.id}`)).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(2);
  });

  it("EXT-03 an earlier expiry is 400 and never settles", async () => {
    const it = await makeItem({ ttlDays: 300 });
    const res = await payingFetch()(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 7 }) });
    const err = await expectError(res, 400, "invalid_request");
    expect(err.expires_at).toBe(it.body.expires_at);
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("EXT-04 more than a year is 400 without settle", async () => {
    const it = await makeItem();
    const res = await payingFetch()(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 366 }) });
    await expectError(res, 400, "invalid_request");
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("EXT-05 wrong secret is 404 without settle", async () => {
    const it = await makeItem();
    const res = await payingFetch()(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth("sk_wrong"), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 30 }) });
    await expectError(res, 404, "not_found");
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("EXT-06 settle comes first, then the metadata update retries until it lands", async () => {
    const it = await makeItem();
    const { testHooks } = await import("../src/hooks");
    let dropped = 0;
    testHooks.dropMetaWrite = (m) => {
      if ((m as { lastPayment?: { type: string } }).lastPayment?.type === "extend" && dropped < 2) {
        dropped++;
        return true;
      }
      return false;
    };
    const res = await payingFetch()(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 30 }) });
    expect(res.status).toBe(200);
    expect(dropped).toBe(2);
    expect(facilitator.settleCalls).toHaveLength(2);
    expect(days((await meta(it.id)).expiresAt, new Date().toISOString())).toBe(30);
  });

  it("EXT-07 an expired item cannot be extended", async () => {
    const it = await makeItem({ ttlDays: 1 });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse(it.body.expires_at as string) + 1000);
      const res = await rawFetch(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 30 }) });
      expect(res.status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it("EXT-08 extending keeps the read counter", async () => {
    const it = await makeItem();
    for (let i = 0; i < 3; i++) await (await get(it.id, it.secret)).arrayBuffer();
    await settle();
    const res = await payingFetch()(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 30 }) });
    expect(((await res.json()) as { reads_remaining: number }).reads_remaining).toBe(97);
  });

  it("EXT-09 the extension is in the payment log", async () => {
    const it = await makeItem();
    const logs = vi.spyOn(console, "log");
    await payingFetch()(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 30 }) });
    const entries = logs.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.kind === "payment");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: "extend", item_id: it.id, result: "settled" });
  });

  it("EXT bad JSON body is 400", async () => {
    const it = await makeItem();
    const res = await rawFetch(`${API}/v1/items/${it.id}/extend`, { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: "{oops" });
    await expectError(res, 400, "invalid_request");
  });
});

describe("read packs and pay-on-read (RD)", () => {
  async function exhaust(id: string): Promise<void> {
    const m = await meta(id);
    await bucket().put(`meta/${id}`, JSON.stringify({ ...m, readsRemaining: 0 }));
  }

  it("RD-01 unpaid read pack is 402", async () => {
    const it = await makeItem();
    await expectError(await rawFetch(`${API}/v1/items/${it.id}/reads`, { method: "POST" }), 402, "payment_required");
  });

  it("RD-02 RD-03 anyone can buy a pack, no secret needed", async () => {
    const it = await makeItem();
    await bucket().put(`meta/${it.id}`, JSON.stringify({ ...(await meta(it.id)), readsRemaining: 40 }));
    const res = await payingFetch()(`${API}/v1/items/${it.id}/reads`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.reads_remaining).toBe(1040);
    expect(body).not.toHaveProperty("secret");
    expect(body.payment.amount).toBe("0.01");
    expect((await status(it.id, it.secret)).status).toBe(200);
  });

  it("RD-04 a pack for an unknown item is 404 without settle", async () => {
    const res = await payingFetch()(`${API}/v1/items/itm_${"B".repeat(22)}/reads`, { method: "POST" });
    await expectError(res, 404, "not_found");
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("RD-05 paying on the GET itself adds a pack and returns the content", async () => {
    const it = await makeItem({ body: fixtures.json });
    await exhaust(it.id);
    const res = await payingFetch()(`${API}/v1/items/${it.id}`, { headers: auth(it.secret) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-reads-remaining")).toBe("999");
    expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!).success).toBe(true);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixtures.json);
    expect(facilitator.settleCalls).toHaveLength(2);
    await settle();
    expect((await meta(it.id)).readsRemaining).toBe(999);
  });

  it("RD-06 a payment header on a GET with reads left is ignored, not charged", async () => {
    const it = await makeItem();
    const { header } = await signedHeaderFor(`${API}/v1/items/${it.id}/reads`, { method: "POST" });
    const res = await get(it.id, it.secret, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-reads-remaining")).toBe("99");
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("RD-09 packs and paid reads are in the payment log", async () => {
    const it = await makeItem();
    await exhaust(it.id);
    const logs = vi.spyOn(console, "log");
    await payingFetch()(`${API}/v1/items/${it.id}/reads`, { method: "POST" });
    await (await payingFetch()(`${API}/v1/items/${it.id}`, { headers: auth(it.secret) })).arrayBuffer();
    const entries = logs.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.kind === "payment");
    expect(entries.filter((e) => e.op === "reads")).toHaveLength(1);
  });

  it("IDEM-11 the same signature twice on extend and on reads applies once and settles once", async () => {
    const it = await makeItem();
    const extendInit = { method: "POST", headers: { ...auth(it.secret), "Content-Type": "application/json" }, body: JSON.stringify({ ttl_days: 30 }) };
    const ext = await signedHeaderFor(`${API}/v1/items/${it.id}/extend`, extendInit);
    const sendExt = () => rawFetch(`${API}/v1/items/${it.id}/extend`, { ...extendInit, headers: { ...extendInit.headers, "PAYMENT-SIGNATURE": ext.header } });
    const a = (await (await sendExt()).json()) as Record<string, any>;
    const b = (await (await sendExt()).json()) as Record<string, any>;
    expect(a.expires_at).toBe(b.expires_at);
    expect(a.payment.tx).toBe(b.payment.tx);

    const rd = await signedHeaderFor(`${API}/v1/items/${it.id}/reads`, { method: "POST" });
    const sendRd = () => rawFetch(`${API}/v1/items/${it.id}/reads`, { method: "POST", headers: { "PAYMENT-SIGNATURE": rd.header } });
    const r1 = (await (await sendRd()).json()) as Record<string, any>;
    const r2 = (await (await sendRd()).json()) as Record<string, any>;
    expect(r1.reads_remaining).toBe(1100);
    expect(r2.reads_remaining).toBe(1100);
    expect(facilitator.settleCalls).toHaveLength(3);
    expect((await meta(it.id)).appliedTx).toHaveLength(2);
  });
});
