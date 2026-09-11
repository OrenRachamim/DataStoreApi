import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { API, DL, auth, bucket, expectError, facilitator, get, listKeys, makeItem, payingFetch, rawFetch, resetAll, settle, status } from "./helpers";
import { fixtures } from "./fixtures";

beforeEach(resetAll);
afterEach(() => vi.restoreAllMocks());

const json = { "Content-Type": "application/json" };

async function makeLink(id: string, secret: string, expiresIn = 3600): Promise<{ url: string; expires_at: string; clamped_to_item_expiry: boolean }> {
  const res = await rawFetch(`${API}/v1/items/${id}/links`, { method: "POST", headers: { ...auth(secret), ...json }, body: JSON.stringify({ expires_in: expiresIn }) });
  if (res.status !== 200) throw new Error(`link failed ${res.status} ${await res.text()}`);
  return (await res.json()) as { url: string; expires_at: string; clamped_to_item_expiry: boolean };
}

async function setPassword(id: string, secret: string, password: string): Promise<Response> {
  return rawFetch(`${API}/v1/items/${id}/password`, { method: "PUT", headers: { ...auth(secret), ...json }, body: JSON.stringify({ password }) });
}

const dlGet = (id: string, headers: Record<string, string> = {}) => rawFetch(`${DL}/d/${id}`, { headers });
const PW = "correct horse battery";

describe("signed links (LNK)", () => {
  it("LNK-01 LNK-02 LNK-10 creating a link stores nothing and the link serves the content", async () => {
    const it = await makeItem({ body: fixtures.json });
    const before = await listKeys();
    const link = await makeLink(it.id, it.secret, 3600);
    expect(await listKeys()).toEqual(before);
    const u = new URL(link.url);
    expect(u.origin).toBe(DL);
    expect(u.pathname).toBe(`/d/${it.id}`);
    for (const p of ["exp", "gen", "sig"]) expect(u.searchParams.get(p)).toBeTruthy();
    expect(Math.abs(Date.parse(link.expires_at) - (Date.now() + 3600_000))).toBeLessThan(5000);
    const res = await rawFetch(link.url);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(fixtures.json);
    expect(res.headers.get("x-reads-remaining")).toBe("99");
  });

  it("LNK-03 an expired link is 404", async () => {
    const it = await makeItem();
    const link = await makeLink(it.id, it.secret, 60);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      await expectError(await rawFetch(link.url), 404, "not_found");
    } finally {
      vi.useRealTimers();
    }
  });

  it("LNK-04 a link longer than the item is clamped to the item's expiry", async () => {
    const it = await makeItem({ ttlDays: 1 });
    const link = await makeLink(it.id, it.secret, 2 * 86_400);
    expect(link.clamped_to_item_expiry).toBe(true);
    expect(Math.abs(Date.parse(link.expires_at) - Date.parse(it.body.expires_at as string))).toBeLessThan(1000);
  });

  it("LNK-05 LNK-06 a tampered signature or expiry is 404", async () => {
    const it = await makeItem();
    const link = await makeLink(it.id, it.secret);
    const u = new URL(link.url);
    const sig = u.searchParams.get("sig")!;
    u.searchParams.set("sig", (sig[0] === "a" ? "b" : "a") + sig.slice(1));
    await expectError(await rawFetch(u.toString()), 404, "not_found");
    const u2 = new URL(link.url);
    u2.searchParams.set("exp", String(Number(u2.searchParams.get("exp")) + 100000));
    await expectError(await rawFetch(u2.toString()), 404, "not_found");
  });

  it("LNK-07 LNK-08 revoke kills old links, new links work", async () => {
    const it = await makeItem();
    const old = await makeLink(it.id, it.secret);
    const rev = await rawFetch(`${API}/v1/items/${it.id}/links/revoke`, { method: "POST", headers: auth(it.secret) });
    expect(rev.status).toBe(204);
    await expectError(await rawFetch(old.url), 404, "not_found");
    const fresh = await makeLink(it.id, it.secret);
    expect((await rawFetch(fresh.url)).status).toBe(200);
  });

  it("LNK-09 a signed link bypasses the password", async () => {
    const it = await makeItem();
    expect((await setPassword(it.id, it.secret, PW)).status).toBe(204);
    const link = await makeLink(it.id, it.secret);
    expect((await rawFetch(link.url)).status).toBe(200);
  });

  it("LNK-11 creating a link with the wrong secret is 404", async () => {
    const it = await makeItem();
    const res = await rawFetch(`${API}/v1/items/${it.id}/links`, { method: "POST", headers: { ...auth("sk_nope"), ...json }, body: JSON.stringify({ expires_in: 60 }) });
    await expectError(res, 404, "not_found");
  });

  it("LNK-12 signatures are deterministic for the same parameters", async () => {
    const { linkSignature } = await import("../src/routes/share");
    const { configFromEnv } = await import("../src/env");
    const { env } = await import("cloudflare:test");
    const cfg = configFromEnv(env as never);
    expect(await linkSignature(cfg, "itm_x", 1, 1)).toBe(await linkSignature(cfg, "itm_x", 1, 1));
    expect(await linkSignature(cfg, "itm_x", 1, 1)).not.toBe(await linkSignature(cfg, "itm_x", 2, 1));
  });

  it("LNK-13 DEL-03 links die with the item", async () => {
    const it = await makeItem();
    const link = await makeLink(it.id, it.secret);
    await rawFetch(`${API}/v1/items/${it.id}`, { method: "DELETE", headers: auth(it.secret) });
    await expectError(await rawFetch(link.url), 404, "not_found");
  });

  it("LNK bad expires_in is 400", async () => {
    const it = await makeItem();
    for (const v of [0, -1, "x", 1.5]) {
      const res = await rawFetch(`${API}/v1/items/${it.id}/links`, { method: "POST", headers: { ...auth(it.secret), ...json }, body: JSON.stringify({ expires_in: v }) });
      await expectError(res, 400, "invalid_request");
    }
  });

  it("RD-07 paying on a signed link when reads are gone works", async () => {
    const it = await makeItem({ body: fixtures.json });
    const m = JSON.parse(await (await bucket().get(`meta/${it.id}`))!.text());
    await bucket().put(`meta/${it.id}`, JSON.stringify({ ...m, readsRemaining: 0 }));
    const link = await makeLink(it.id, it.secret);
    await expectError(await rawFetch(link.url), 402, "reads_exhausted");
    const res = await payingFetch()(link.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-reads-remaining")).toBe("999");
    expect(facilitator.settleCalls).toHaveLength(2);
  });
});

describe("password (PWD)", () => {
  it("PWD-01 PWD-02 PWD-03 set, too short, too long", async () => {
    const it = await makeItem();
    expect((await setPassword(it.id, it.secret, PW)).status).toBe(204);
    const m = JSON.parse(await (await bucket().get(`meta/${it.id}`))!.text());
    expect(m.password.iterations).toBe(100000);
    expect(JSON.stringify(m)).not.toContain(PW);
    expect(((await (await status(it.id, it.secret)).json()) as { has_password: boolean }).has_password).toBe(true);
    await expectError(await setPassword(it.id, it.secret, "elevenchars"), 400, "invalid_request");
    await expectError(await setPassword(it.id, it.secret, "x".repeat(129)), 400, "invalid_request");
  });

  it("PWD-04 PWD-05 correct password serves and counts, wrong is the uniform 404 and does not count", async () => {
    const it = await makeItem({ body: fixtures.json });
    await setPassword(it.id, it.secret, PW);
    const ok = await dlGet(it.id, { "X-Password": PW });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-reads-remaining")).toBe("99");
    const bad = await dlGet(it.id, { "X-Password": "wrong password!!" });
    const body = await expectError(bad, 404, "not_found");
    const ref = await expectError(await dlGet("itm_" + "C".repeat(22), { "X-Password": PW }), 404, "not_found");
    delete body.request_id;
    delete ref.request_id;
    expect(body).toEqual(ref);
    await settle();
    expect(JSON.parse(await (await bucket().get(`meta/${it.id}`))!.text()).readsRemaining).toBe(99);
  });

  it("PWD-06 PWD-07 no password: agents get 404, browsers get the form", async () => {
    const it = await makeItem();
    await setPassword(it.id, it.secret, PW);
    await expectError(await dlGet(it.id, { Accept: "application/json" }), 404, "not_found");
    const page = await dlGet(it.id, { Accept: "text/html,application/xhtml+xml" });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("<form");
    expect(html).toContain(`action="/d/${it.id}"`);
    expect(html).not.toContain(it.secret);
  });

  it("PWD-08 the form posts the password and gets the file", async () => {
    const it = await makeItem({ body: fixtures.png, contentType: "image/png" });
    await setPassword(it.id, it.secret, PW);
    const res = await rawFetch(`${DL}/d/${it.id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body: new URLSearchParams({ password: PW }).toString() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const wrong = await rawFetch(`${DL}/d/${it.id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body: new URLSearchParams({ password: "not the password" }).toString() });
    expect(wrong.status).toBe(200);
    expect(await wrong.text()).toContain("Wrong password");
  });

  it("PWD-09 replacing the password does not need the old one", async () => {
    const it = await makeItem();
    await setPassword(it.id, it.secret, PW);
    expect((await setPassword(it.id, it.secret, "another strong one")).status).toBe(204);
    expect((await dlGet(it.id, { "X-Password": PW })).status).toBe(404);
    expect((await dlGet(it.id, { "X-Password": "another strong one" })).status).toBe(200);
  });

  it("PWD-10 PWD-17 removing the password closes the password path", async () => {
    const it = await makeItem();
    await setPassword(it.id, it.secret, PW);
    const del = await rawFetch(`${API}/v1/items/${it.id}/password`, { method: "DELETE", headers: auth(it.secret) });
    expect(del.status).toBe(204);
    expect((await dlGet(it.id, { "X-Password": PW })).status).toBe(404);
    expect((await dlGet(it.id, { Accept: "text/html" })).status).toBe(404);
    expect(((await (await status(it.id, it.secret)).json()) as { has_password: boolean }).has_password).toBe(false);
  });

  it("PWD-11 PWD-12 PWD-14 PWD-15 five failures lock the item, the owner is unaffected, time unlocks", async () => {
    const it = await makeItem();
    await setPassword(it.id, it.secret, PW);
    for (let i = 0; i < 5; i++) expect((await dlGet(it.id, { "X-Password": `wrong attempt ${i}!` })).status).toBe(404);
    const locked = await dlGet(it.id, { "X-Password": PW });
    await expectError(locked, 423, "locked");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    const m = JSON.parse(await (await bucket().get(`meta/${it.id}`))!.text());
    expect(m.lock.failures).toBe(5);
    expect(m.lock.lockedUntil).toBeTruthy();
    expect((await get(it.id, it.secret)).status).toBe(200);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
      expect((await dlGet(it.id, { "X-Password": PW })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("PWD-13 failures outside the 15 minute window do not accumulate", async () => {
    const it = await makeItem();
    await setPassword(it.id, it.secret, PW);
    for (let i = 0; i < 4; i++) await dlGet(it.id, { "X-Password": `wrong attempt ${i}!` });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await dlGet(it.id, { "X-Password": "still wrong!!!" });
      expect((await dlGet(it.id, { "X-Password": PW })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("PWD-16 hashing uses a random salt and verifies in reasonable time", async () => {
    const { hashPassword, verifyPassword } = await import("../src/password");
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    const t = Date.now();
    expect(await verifyPassword(PW, a)).toBe(true);
    expect(await verifyPassword("nope nope nope", a)).toBe(false);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it("RD-08 a browser with the right password but no reads gets a 402 page, not content", async () => {
    const it = await makeItem();
    await setPassword(it.id, it.secret, PW);
    const m = JSON.parse(await (await bucket().get(`meta/${it.id}`))!.text());
    await bucket().put(`meta/${it.id}`, JSON.stringify({ ...m, readsRemaining: 0 }));
    const res = await rawFetch(`${DL}/d/${it.id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" }, body: new URLSearchParams({ password: PW }).toString() });
    expect(res.status).toBe(402);
    expect(await res.text()).toContain("no reads left");
  });

  it("RL-01 RL-04 more than 30 password attempts a minute from one IP are 429 and not counted", async () => {
    const it = await makeItem();
    await setPassword(it.id, it.secret, PW);
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) last = await dlGet(it.id, { "X-Password": PW, "CF-Connecting-IP": "203.0.113.9" });
    await expectError(last!, 429, "rate_limited");
    expect(last!.headers.get("retry-after")).toBe("60");
    expect(last!.headers.get("ratelimit-limit")).toBe("30");
    const other = await dlGet(it.id, { "X-Password": PW, "CF-Connecting-IP": "203.0.113.10" });
    expect(other.status).toBe(200);
    await settle();
    expect(JSON.parse(await (await bucket().get(`meta/${it.id}`))!.text()).readsRemaining).toBe(100 - 31);
  });
});

describe("share domain headers (DL)", () => {
  it("DL-01 DL-02 DL-04 HTML and SVG are inline under the sandbox on the share domain", async () => {
    for (const [body, ct] of [
      [fixtures.scriptHtml, "text/html"],
      [fixtures.scriptSvg, "image/svg+xml"],
    ] as Array<[Uint8Array, string]>) {
      const it = await makeItem({ body, contentType: ct });
      const link = await makeLink(it.id, it.secret);
      const res = await rawFetch(link.url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(ct);
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-popups");
      expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    }
  });

  it("DL-05 DL-06 DL-07 other files are attachments with the base headers and no cookies", async () => {
    for (const [body, ct, ext] of [
      [fixtures.png, "image/png", ".png"],
      [fixtures.pdf, "application/pdf", ".pdf"],
      [fixtures.csv, "text/csv", ".csv"],
      [fixtures.json, "application/json", ".json"],
    ] as Array<[Uint8Array, string, string]>) {
      const it = await makeItem({ body, contentType: ct });
      const link = await makeLink(it.id, it.secret);
      const res = await rawFetch(link.url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain(`attachment; filename="${it.id}${ext}"`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("DL-08 each domain answers only its own routes", async () => {
    const it = await makeItem();
    const link = await makeLink(it.id, it.secret);
    const onDl = await rawFetch(`${DL}/v1/items/${it.id}`, { headers: auth(it.secret) });
    await expectError(onDl, 404, "not_found");
    const onApi = await rawFetch(link.url.replace(DL, API));
    await expectError(onApi, 404, "not_found");
    expect((await rawFetch(`${DL}/llms.txt`)).status).toBe(404);
  });

  it("DL-09 the password page has a strict CSP and posts to itself", async () => {
    const it = await makeItem();
    await setPassword(it.id, it.secret, PW);
    const page = await dlGet(it.id, { Accept: "text/html" });
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(await page.text()).not.toContain("<script");
  });

  it("LOG-03 LOG-04 passwords and link signatures never reach the logs", async () => {
    const logs = vi.spyOn(console, "log");
    const it = await makeItem();
    await setPassword(it.id, it.secret, PW);
    await dlGet(it.id, { "X-Password": PW });
    await dlGet(it.id, { "X-Password": "wrong one here!" });
    const link = await makeLink(it.id, it.secret);
    await rawFetch(link.url);
    const all = logs.mock.calls.map((c) => String(c[0])).join("\n");
    expect(all).not.toContain(PW);
    expect(all).not.toContain("wrong one here");
    expect(all).not.toContain(new URL(link.url).searchParams.get("sig")!);
    expect(all).not.toContain("sig=");
  });
});
