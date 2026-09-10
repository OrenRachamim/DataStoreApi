import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { API, bucket, expectError, facilitator, get, listKeys, makeItem, rawFetch, resetAll, settle, status } from "./helpers";
import { fixtures, pngOfSize } from "./fixtures";

beforeEach(resetAll);
afterEach(() => vi.restoreAllMocks());

async function readsRemaining(id: string): Promise<number> {
  const meta = JSON.parse(await (await bucket().get(`meta/${id}`))!.text()) as { readsRemaining: number };
  return meta.readsRemaining;
}

describe("retrieve (GET)", () => {
  it("GET-01 JSON comes back inline, byte for byte, with counters", async () => {
    const it = await makeItem({ body: fixtures.json });
    const res = await get(it.id, it.secret);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("x-reads-remaining")).toBe("99");
    expect(res.headers.get("x-expires-at")).toBe(it.body.expires_at);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixtures.json);
  });

  it("GET-02 HTML and SVG come back inline under a CSP sandbox", async () => {
    for (const [body, ct] of [
      [fixtures.html, "text/html"],
      [fixtures.svg, "image/svg+xml"],
    ] as Array<[Uint8Array, string]>) {
      const it = await makeItem({ body, contentType: ct });
      const res = await get(it.id, it.secret);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(ct);
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups");
    }
  });

  it("GET-03 a file comes back as an attachment with nosniff", async () => {
    const it = await makeItem({ body: fixtures.png, contentType: "image/png" });
    const res = await get(it.id, it.secret);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(".png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("GET-04 GET-05 GET-06 wrong secret, missing secret and unknown id are the same 404", async () => {
    const a = await makeItem();
    const b = await makeItem();
    const wrong = await get(a.id, b.secret);
    const missing = await rawFetch(`${API}/v1/items/${a.id}`);
    const unknown = await get("itm_" + "A".repeat(22), a.secret);
    const bodies = [];
    for (const res of [wrong, missing, unknown]) {
      const body = await expectError(res, 404, "not_found");
      delete body.request_id;
      bodies.push(JSON.stringify(body));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("GET-07 an item past its expiry is 404 even before the cron runs", async () => {
    const it = await makeItem({ ttlDays: 1 });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse(it.body.expires_at as string) + 1000);
      await expectError(await get(it.id, it.secret), 404, "not_found");
      await expectError(await status(it.id, it.secret), 404, "not_found");
    } finally {
      vi.useRealTimers();
    }
    expect(await listKeys(`items/${it.id}`)).toHaveLength(1);
  });

  it("GET-08 a 25 MB item streams back whole", async () => {
    const data = pngOfSize(26214400);
    const it = await makeItem({ body: data, contentType: "image/png" });
    const res = await get(it.id, it.secret);
    expect(res.status).toBe(200);
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.byteLength).toBe(data.byteLength);
    expect(got[0]).toBe(0x89);
    expect(got[got.byteLength - 1]).toBe(data[data.byteLength - 1]);
  });
});

describe("read counter (CNT)", () => {
  it("CNT-01 each read decrements, header and metadata agree", async () => {
    const it = await makeItem();
    for (const expected of ["99", "98", "97"]) {
      const res = await get(it.id, it.secret);
      expect(res.headers.get("x-reads-remaining")).toBe(expected);
      await res.arrayBuffer();
    }
    await settle();
    expect(await readsRemaining(it.id)).toBe(97);
  });

  it("CNT-02 status calls do not count", async () => {
    const it = await makeItem();
    for (let i = 0; i < 5; i++) expect((await status(it.id, it.secret)).status).toBe(200);
    const res = await get(it.id, it.secret);
    expect(res.headers.get("x-reads-remaining")).toBe("99");
  });

  it("CNT-03 failed attempts do not count", async () => {
    const it = await makeItem();
    for (let i = 0; i < 5; i++) expect((await get(it.id, "sk_wrong")).status).toBe(404);
    await settle();
    expect(await readsRemaining(it.id)).toBe(100);
  });

  it("CNT-04 the 101st read is an x402 402 with the expiry", async () => {
    const it = await makeItem();
    for (let i = 0; i < 100; i++) {
      const res = await get(it.id, it.secret);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      await settle(5);
    }
    await settle();
    expect(await readsRemaining(it.id)).toBe(0);
    const res = await get(it.id, it.secret);
    const err = await expectError(res, 402, "reads_exhausted");
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect((err.action as { url: string }).url).toBe(`${API}/v1/items/${it.id}/reads`);
    expect((err.x402 as { accepts: Array<{ amount: string }> }).accepts[0].amount).toBe("10000");
  });

  it("CNT-05 soft counter under concurrency never goes negative or crashes", async () => {
    const it = await makeItem();
    await bucket().put(`meta/${it.id}`, JSON.stringify({ ...JSON.parse(await (await bucket().get(`meta/${it.id}`))!.text()), readsRemaining: 10 }));
    const results = await Promise.all(Array.from({ length: 20 }, () => get(it.id, it.secret)));
    const ok = results.filter((r) => r.status === 200).length;
    const paywalled = results.filter((r) => r.status === 402).length;
    expect(ok).toBeGreaterThanOrEqual(10);
    expect(ok + paywalled).toBe(20);
    await settle(200);
    expect(await readsRemaining(it.id)).toBeGreaterThanOrEqual(0);
  });

  it("CNT-06 conditional writes resolve a stale etag by retrying", async () => {
    const { updateMeta } = await import("../src/store");
    const it = await makeItem();
    const results = await Promise.all([
      updateMeta(bucket(), it.id, (m) => void (m.readsRemaining -= 1)),
      updateMeta(bucket(), it.id, (m) => void (m.readsRemaining -= 1)),
      updateMeta(bucket(), it.id, (m) => void (m.readsRemaining -= 1)),
    ]);
    expect(results.every(Boolean)).toBe(true);
    expect(await readsRemaining(it.id)).toBe(97);
  });
});

describe("status and delete (ST, DEL)", () => {
  it("ST-01 status returns the item object without the secret", async () => {
    const it = await makeItem({ label: "lbl" });
    const res = await status(it.id, it.secret);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("secret");
    expect(body).toMatchObject({ id: it.id, label: "lbl", has_password: false, reads_remaining: 100 });
    expect(Object.keys(body.links as object)).toHaveLength(6);
  });

  it("ST-03 status with a wrong secret is 404", async () => {
    const it = await makeItem();
    await expectError(await status(it.id, "sk_nope"), 404, "not_found");
  });

  it("DEL-01 delete removes everything and later calls are 404", async () => {
    const it = await makeItem();
    const res = await rawFetch(`${API}/v1/items/${it.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${it.secret}` } });
    expect(res.status).toBe(204);
    expect(await listKeys("items/")).toEqual([]);
    expect(await listKeys("meta/")).toEqual([]);
    expect((await listKeys("expiry/")).filter((k) => k.endsWith(`/${it.id}`))).toEqual([]);
    await expectError(await get(it.id, it.secret), 404, "not_found");
    await expectError(await status(it.id, it.secret), 404, "not_found");
  });

  it("DEL-02 deleting twice is 404", async () => {
    const it = await makeItem();
    const del = () => rawFetch(`${API}/v1/items/${it.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${it.secret}` } });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);
  });

  it("DEL-04 delete with a wrong secret is 404 and keeps the item", async () => {
    const it = await makeItem();
    const res = await rawFetch(`${API}/v1/items/${it.id}`, { method: "DELETE", headers: { Authorization: "Bearer sk_wrong" } });
    expect(res.status).toBe(404);
    expect(await listKeys(`items/${it.id}`)).toHaveLength(1);
  });

  it("DEL-05 deleting while a large read is in flight does not 500", async () => {
    const it = await makeItem({ body: pngOfSize(8 * 1024 * 1024), contentType: "image/png" });
    const reading = get(it.id, it.secret);
    const del = await rawFetch(`${API}/v1/items/${it.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${it.secret}` } });
    expect([204, 404]).toContain(del.status);
    const res = await reading;
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) await res.arrayBuffer().catch(() => {});
    expect((await get(it.id, it.secret)).status).toBe(404);
  });
});

describe("logging (LOG)", () => {
  it("LOG-02 LOG-05 LOG-06 LOG-10 logs carry request ids and never secrets, payment headers or content", async () => {
    const logs = vi.spyOn(console, "log");
    const marker = "UNIQUE-CONTENT-MARKER-4711";
    const it = await makeItem({ body: new TextEncoder().encode(JSON.stringify({ marker })), contentType: "application/json" });
    const res = await get(it.id, it.secret);
    await res.arrayBuffer();
    const all = logs.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toContain(it.secret);
    expect(all).not.toContain(marker);
    expect(all).not.toContain("PAYMENT-SIGNATURE");
    expect(all).not.toContain('"signature"');
    const reqLogs = logs.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.kind === "request");
    const forGet = reqLogs.find((l) => l.request_id === res.headers.get("x-request-id"));
    expect(forGet).toBeTruthy();
    expect(forGet).toMatchObject({ method: "GET", status: 200, item_id: it.id, access: "secret" });
    expect(typeof forGet!.ip_hash).toBe("string");
    logs.mockRestore();
  });
});
