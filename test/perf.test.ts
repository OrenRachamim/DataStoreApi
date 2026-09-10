import { describe, it, expect, beforeEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { API, auth, facilitator, get, makeItem, payingFetch, resetAll, settle } from "./helpers";
import { fixtures, jsonOfSize } from "./fixtures";

beforeEach(resetAll);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

describe("limits and load (PERF)", () => {
  it("PERF-01 100 small reads: p95 under 200 ms locally", async () => {
    const it = await makeItem({ body: fixtures.json });
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t = Date.now();
      const res = await get(it.id, it.secret);
      await res.arrayBuffer();
      times.push(Date.now() - t);
      expect(res.status).toBe(200);
    }
    expect(percentile(times, 0.95)).toBeLessThan(200);
  });

  it("PERF-03 50 concurrent uploads from 50 wallets all succeed with unique ids", async () => {
    const wallets = Array.from({ length: 50 }, () => privateKeyToAccount(generatePrivateKey()));
    const results = await Promise.all(
      wallets.map((w, i) => payingFetch(w)(`${API}/v1/items?label=w${i}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ i }) })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(await Promise.all(results.map(async (r) => ((await r.json()) as { id: string }).id)));
    expect(ids.size).toBe(50);
    expect(facilitator.settleCalls).toHaveLength(50);
  });

  it("PERF-04 200 concurrent reads of one item: only 200 or 402, never 500", async () => {
    const it = await makeItem({ body: fixtures.json });
    const results = await Promise.all(Array.from({ length: 200 }, () => get(it.id, it.secret)));
    const statuses = new Set(results.map((r) => r.status));
    for (const s of statuses) expect([200, 402]).toContain(s);
    await Promise.all(results.map((r) => r.arrayBuffer().catch(() => undefined)));
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(100);
    await settle(300);
  });

  it("PERF-05 two 20 MB JSON uploads in parallel do not crash the worker", async () => {
    const body = jsonOfSize(20 * 1024 * 1024);
    const [a, b] = await Promise.all([
      payingFetch()(`${API}/v1/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
      payingFetch()(`${API}/v1/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const sa = (await a.json()) as { id: string; secret: string };
    const res = await get(sa.id, sa.secret, { headers: auth(sa.secret) });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(body.byteLength);
  });
});
