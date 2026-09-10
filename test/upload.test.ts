import { describe, it, expect, beforeEach } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { API, PAY_TO, NETWORK, expectError, facilitator, listKeys, makeItem, rawFetch, resetAll, upload, uploadInit, uploadUrl, bucket, walletA } from "./helpers";
import { fixtures, jsonOfSize, pngOfSize } from "./fixtures";

beforeEach(resetAll);

const MAX = 26214400;

describe("upload (UP)", () => {
  it("UP-01 first request gets an x402 402 without payment", async () => {
    const res = await rawFetch(uploadUrl(), uploadInit());
    const body = await expectError(res, 402, "payment_required");
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const required = decodePaymentRequiredHeader(header!);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    const acc = required.accepts[0];
    expect(acc.amount).toBe("10000");
    expect(acc.payTo.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(acc.network).toBe(NETWORK);
    expect(acc.maxTimeoutSeconds).toBe(600);
    expect(body.terms).toBe(`${API}/terms`);
    expect((body.x402 as { accepts: unknown[] }).accepts).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("UP-02 402 is returned without storing anything even for a large body", async () => {
    const res = await rawFetch(uploadUrl(), uploadInit({ body: pngOfSize(MAX), contentType: "image/png" }));
    expect(res.status).toBe(402);
    expect(await listKeys()).toEqual([]);
  });

  it("UP-03 upload JSON with automatic payment", async () => {
    const before = Date.now();
    const res = await upload({ body: fixtures.json });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.id).toMatch(/^itm_[A-Za-z0-9_-]{22}$/);
    expect(body.secret).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    expect(body.content_type).toBe("application/json");
    expect(body.size).toBe(fixtures.json.byteLength);
    expect(body.reads_remaining).toBe(100);
    expect(body.has_password).toBe(false);
    const exp = Date.parse(body.expires_at);
    expect(exp).toBeGreaterThanOrEqual(before + 7 * 86_400_000 - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000 + 1000);
    expect(body.payment).toMatchObject({ amount: "0.01", currency: "USDC", network: "base-sepolia" });
    expect(body.payment.tx).toMatch(/^0x/);
    const pr = res.headers.get("PAYMENT-RESPONSE");
    expect(pr).toBeTruthy();
    expect(decodePaymentResponseHeader(pr!).success).toBe(true);
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("UP-04 every allowed type is accepted with the right detected type", async () => {
    const cases: Array<[Uint8Array, string | undefined, string]> = [
      [fixtures.json, "application/json", "application/json"],
      [fixtures.html, "text/html", "text/html"],
      [fixtures.svg, "image/svg+xml", "image/svg+xml"],
      [fixtures.txt, "text/plain", "text/plain"],
      [fixtures.md, "text/markdown", "text/markdown"],
      [fixtures.csv, "text/csv", "text/csv"],
      [fixtures.pdf, "application/pdf", "application/pdf"],
      [fixtures.png, "image/png", "image/png"],
      [fixtures.jpg, "image/jpeg", "image/jpeg"],
      [fixtures.webp, "image/webp", "image/webp"],
      [fixtures.gif, "image/gif", "image/gif"],
    ];
    for (const [body, declared, expected] of cases) {
      const res = await upload({ body, contentType: declared });
      expect(res.status, expected).toBe(201);
      expect(((await res.json()) as { content_type: string }).content_type).toBe(expected);
    }
  });

  it("UP-05 forbidden types are 415 and never settle", async () => {
    for (const [body, ct] of [
      [fixtures.zip, "application/zip"],
      [fixtures.exe, "application/octet-stream"],
      [fixtures.sh, "text/x-sh"],
    ] as Array<[Uint8Array, string]>) {
      const res = await upload({ body, contentType: ct });
      const err = await expectError(res, 415, "unsupported_type");
      expect(Array.isArray(err.allowed_content_types)).toBe(true);
    }
    expect(facilitator.verifyCalls.length).toBeGreaterThan(0);
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(await listKeys("items/")).toEqual([]);
  });

  it("UP-06 HTML disguised as PNG is stored as HTML", async () => {
    const res = await upload({ body: fixtures.html, contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { content_type: string }).content_type).toBe("text/html");
  });

  it("UP-07 PNG disguised as JSON is stored as PNG", async () => {
    const res = await upload({ body: fixtures.png, contentType: "application/json" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { content_type: string }).content_type).toBe("image/png");
  });

  it("UP-08 no Content-Type at all", async () => {
    const res = await upload({ body: fixtures.png, contentType: null });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { content_type: string }).content_type).toBe("image/png");
  });

  it("UP-09 octet-stream is detected", async () => {
    const res = await upload({ body: fixtures.pdf, contentType: "application/octet-stream" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { content_type: string }).content_type).toBe("application/pdf");
  });

  it("UP-10 UP-11 UP-12 broken JSON, UTF-8 and SVG are 415 without settle", async () => {
    await expectError(await upload({ body: fixtures.invalidJson, contentType: "application/json" }), 415, "unsupported_type");
    await expectError(await upload({ body: fixtures.invalidUtf8, contentType: "text/plain" }), 415, "unsupported_type");
    await expectError(await upload({ body: fixtures.svgNoRoot, contentType: "image/svg+xml" }), 415, "unsupported_type");
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("UP-13 exactly 25 MB is accepted", async () => {
    const res = await upload({ body: pngOfSize(MAX), contentType: "image/png" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { size: number }).size).toBe(MAX);
  });

  it("UP-14 one byte over is 413 without settle", async () => {
    const res = await upload({ body: pngOfSize(MAX + 1), contentType: "image/png" });
    await expectError(res, 413, "too_large");
    expect(facilitator.settleCalls).toHaveLength(0);
    expect(await listKeys("items/")).toEqual([]);
  });

  it("UP-15 a lying Content-Length does not bypass the limit", async () => {
    // fetch sets the real Content-Length; simulate the lie by streaming without one.
    const big = pngOfSize(MAX + 1024);
    const stream = new ReadableStream({
      start(ctrl) {
        for (let off = 0; off < big.byteLength; off += 1 << 20) ctrl.enqueue(big.subarray(off, Math.min(off + (1 << 20), big.byteLength)));
        ctrl.close();
      },
    });
    const res = await (await import("./helpers")).payingFetch()(uploadUrl(), { method: "POST", body: stream, headers: { "Content-Type": "image/png", "Content-Length": "1000" }, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("UP-16 chunked upload without Content-Length works", async () => {
    const data = pngOfSize(1 << 20);
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(data.subarray(0, 4096));
        ctrl.enqueue(data.subarray(4096));
        ctrl.close();
      },
    });
    const res = await (await import("./helpers")).payingFetch()(uploadUrl(), { method: "POST", body: stream, headers: { "Content-Type": "image/png" }, duplex: "half" } as RequestInit);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { size: number }).size).toBe(1 << 20);
  });

  it("UP-17 a 20 MB JSON is validated without exhausting memory", async () => {
    const res = await upload({ body: jsonOfSize(20 * 1024 * 1024), contentType: "application/json" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { content_type: string }).content_type).toBe("application/json");
  });

  it("UP-18 UP-19 ttl default and bounds", async () => {
    const d = await makeItem();
    expect(Math.round((Date.parse(d.body.expires_at as string) - Date.parse(d.body.created_at as string)) / 86_400_000)).toBe(7);
    const one = await makeItem({ ttlDays: 1 });
    expect(Math.round((Date.parse(one.body.expires_at as string) - Date.parse(one.body.created_at as string)) / 86_400_000)).toBe(1);
    const year = await makeItem({ ttlDays: 365 });
    expect(Math.round((Date.parse(year.body.expires_at as string) - Date.parse(year.body.created_at as string)) / 86_400_000)).toBe(365);
  });

  it("UP-20 invalid ttl is 400 before any payment", async () => {
    for (const ttl of ["0", "366", "-1", "abc", "1.5"]) {
      const res = await rawFetch(uploadUrl({ ttlDays: ttl }), uploadInit());
      await expectError(res, 400, "invalid_request");
    }
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("UP-21 label round-trips, including Hebrew", async () => {
    const label = "תוצאות סריקה " + "x".repeat(87);
    expect(label.length).toBe(100);
    const item = await makeItem({ label });
    expect(item.body.label).toBe(label);
    const st = await rawFetch(`${API}/v1/items/${item.id}/status`, { headers: { Authorization: `Bearer ${item.secret}` } });
    expect(((await st.json()) as { label: string }).label).toBe(label);
  });

  it("UP-22 label too long is 400 without settle", async () => {
    const res = await rawFetch(uploadUrl({ label: "y".repeat(101) }), uploadInit());
    await expectError(res, 400, "invalid_request");
    expect(facilitator.verifyCalls).toHaveLength(0);
  });

  it("UP-23 empty body is 400 without settle", async () => {
    const res = await upload({ body: new Uint8Array(0), contentType: "text/plain" });
    await expectError(res, 400, "invalid_request");
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("UP-24 ids and secrets are unique and well-formed", async () => {
    const ids = new Set<string>();
    const secrets = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const it = await makeItem();
      ids.add(it.id);
      secrets.add(it.secret);
    }
    expect(ids.size).toBe(20);
    expect(secrets.size).toBe(20);
  });

  it("UP-25 R2 holds content, meta with a hashed secret, and an expiry marker", async () => {
    const it = await makeItem({ body: fixtures.json });
    const keys = await listKeys();
    expect(keys).toContain(`items/${it.id}`);
    expect(keys).toContain(`meta/${it.id}`);
    const day = (it.body.expires_at as string).slice(0, 10);
    expect(keys).toContain(`expiry/${day}/${it.id}`);
    const meta = await (await bucket().get(`meta/${it.id}`))!.text();
    expect(meta).not.toContain(it.secret);
    expect(JSON.parse(meta).tx).toMatch(/^0x/);
    expect(JSON.parse(meta).payer).toBe(walletA.address);
  });

  it("UP-26 every link in the item object is absolute and resolves", async () => {
    const it = await makeItem();
    const links = it.body.links as Record<string, string>;
    expect(Object.keys(links).sort()).toEqual(["delete", "extend", "reads", "self", "share", "status"]);
    for (const url of Object.values(links)) expect(url.startsWith(`${API}/v1/items/${it.id}`)).toBe(true);
    const st = await rawFetch(links.status, { headers: { Authorization: `Bearer ${it.secret}` } });
    expect(st.status).toBe(200);
    const self = await rawFetch(links.self, { headers: { Authorization: `Bearer ${it.secret}` } });
    expect(self.status).toBe(200);
  });
});
