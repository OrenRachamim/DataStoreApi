import { describe, it, expect, beforeEach } from "vitest";
import { API, rawFetch, resetAll } from "./helpers";

beforeEach(resetAll);

describe("free endpoints (DOC)", () => {
  it("DOC-01 llms.txt describes the service", async () => {
    const res = await rawFetch(`${API}/llms.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("$0.01");
    expect(text).toContain("26214400");
    expect(text).toContain("/v1/feedback");
    for (const op of ["POST", "GET", "DELETE"]) expect(text).toContain(op);
  });

  it("DOC-02 openapi.json lists every route", async () => {
    const res = await rawFetch(`${API}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    for (const p of [
      "/v1/items",
      "/v1/items/{id}",
      "/v1/items/{id}/status",
      "/v1/items/{id}/extend",
      "/v1/items/{id}/reads",
      "/v1/items/{id}/links",
      "/v1/items/{id}/links/revoke",
      "/v1/items/{id}/password",
      "/v1/feedback",
      "/v1/pricing",
      "/llms.txt",
      "/tools.json",
      "/terms",
    ]) {
      expect(spec.paths, p).toHaveProperty(p);
    }
  });

  it("DOC-03 tools.json has the seven tools with schemas", async () => {
    const res = await rawFetch(`${API}/tools.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string; input_schema: { type: string; required: string[] } }> };
    expect(body.tools.map((t) => t.name).sort()).toEqual(["delete", "extend", "feedback", "retrieve", "share_link", "status", "store"]);
    for (const t of body.tools) {
      expect(t.input_schema.type).toBe("object");
      expect(Array.isArray(t.input_schema.required)).toBe(true);
    }
  });

  it("DOC-04 pricing", async () => {
    const res = await rawFetch(`${API}/v1/pricing`);
    const p = (await res.json()) as Record<string, unknown>;
    expect(p).toMatchObject({
      upload: "0.01",
      extend: "0.01",
      reads_1000: "0.01",
      currency: "USDC",
      network: "base-sepolia",
      max_bytes: 26214400,
      max_ttl_days: 365,
      included_reads: 100,
    });
  });

  it("DOC-05 terms", async () => {
    expect((await rawFetch(`${API}/terms`)).status).toBe(200);
  });

  it("DOC-06 free routes never ask for payment", async () => {
    for (const p of ["/llms.txt", "/openapi.json", "/tools.json", "/v1/pricing", "/terms"]) {
      const res = await rawFetch(`${API}${p}`);
      expect(res.status, p).not.toBe(402);
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    }
  });

  it("DOC-07 every response carries a unique request id", async () => {
    const a = await rawFetch(`${API}/v1/pricing`);
    const b = await rawFetch(`${API}/nope`);
    const ida = a.headers.get("X-Request-Id");
    const idb = b.headers.get("X-Request-Id");
    expect(ida).toMatch(/^req_/);
    expect(idb).toMatch(/^req_/);
    expect(ida).not.toBe(idb);
  });
});

describe("error envelope (ERR)", () => {
  it("ERR-05 unknown route returns the uniform 404 body", async () => {
    const res = await rawFetch(`${API}/v1/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
    expect(body).toHaveProperty("action");
    expect(body).toHaveProperty("request_id");
    expect(body).toHaveProperty("docs");
    expect(body).toHaveProperty("feedback");
  });

  it("ERR-07 method not allowed carries Allow", async () => {
    const res = await rawFetch(`${API}/v1/items`, { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(((await res.json()) as { error: string }).error).toBe("method_not_allowed");
  });
});
