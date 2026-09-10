import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PaymentPayload } from "@x402/core/types";
import { API, expectError, facilitator, listKeys, manualPay, rawFetch, resetAll, upload, uploadInit, uploadUrl, walletB } from "./helpers";
import { fixtures, pngOfSize } from "./fixtures";
import { testHooks } from "../src/hooks";

beforeEach(resetAll);
afterEach(() => vi.restoreAllMocks());

type Auth = { authorization: Record<string, string>; signature: string };

describe("payment (PAY)", () => {
  it("PAY-01 verify failure is 402 and nothing is written", async () => {
    facilitator.mode = "verify_fail";
    const res = await upload();
    const err = await expectError(res, 402, "payment_required");
    expect(String(err.message)).toContain("insufficient");
    expect(await listKeys()).toEqual([]);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("PAY-02 settle failure after write cleans up and returns 402", async () => {
    facilitator.mode = "settle_fail";
    const logs = vi.spyOn(console, "log");
    const res = await upload({ body: fixtures.json });
    const err = await expectError(res, 402, "payment_required");
    expect(String(err.message)).toContain("settlement failed");
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(await listKeys()).toEqual([]);
    const settleLog = logs.mock.calls.map((c) => String(c[0])).find((l) => l.includes("settle_failed_cleaned"));
    expect(settleLog).toBeTruthy();
    logs.mockRestore();
  });

  it("PAY-03 settle timeout behaves like a failure", async () => {
    facilitator.mode = "settle_timeout";
    const res = await upload();
    await expectError(res, 402, "payment_required");
    expect(await listKeys()).toEqual([]);
  });

  it("PAY-04 wrong amount is rejected before settle", async () => {
    const res = await manualPay(uploadUrl(), uploadInit(), (p) => {
      const a = (p.payload as Auth).authorization;
      return { ...p, payload: { ...p.payload, authorization: { ...a, value: "9999" } } };
    });
    await expectError(res, 402, "payment_required");
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("PAY-05 wrong recipient is rejected before settle", async () => {
    const res = await manualPay(uploadUrl(), uploadInit(), (p) => {
      const a = (p.payload as Auth).authorization;
      return { ...p, payload: { ...p.payload, authorization: { ...a, to: walletB.address } } };
    });
    await expectError(res, 402, "payment_required");
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("PAY-06 wrong network is rejected", async () => {
    const res = await manualPay(uploadUrl(), uploadInit(), (p) => ({ ...p, accepted: { ...p.accepted, network: "eip155:8453" as `${string}:${string}` } }));
    await expectError(res, 402, "payment_required");
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("PAY-07 expired authorization is rejected", async () => {
    const res = await manualPay(uploadUrl(), uploadInit(), (p) => {
      const a = (p.payload as Auth).authorization;
      return { ...p, payload: { ...p.payload, authorization: { ...a, validBefore: String(Math.floor(Date.now() / 1000) - 10) } } };
    });
    await expectError(res, 402, "payment_required");
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("PAY-08 a forged payer is rejected locally, without any facilitator call", async () => {
    const res = await manualPay(uploadUrl(), uploadInit(), (p) => {
      const a = (p.payload as Auth).authorization;
      return { ...p, payload: { ...p.payload, authorization: { ...a, from: walletB.address } } };
    });
    const err = await expectError(res, 402, "payment_required");
    expect(String(err.message)).toContain("signature");
    expect(facilitator.verifyCalls).toHaveLength(0);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("PAY-09 verify runs before the body is read", async () => {
    facilitator.mode = "verify_fail";
    const res = await upload({ body: pngOfSize(5 * 1024 * 1024), contentType: "image/png" });
    expect(res.status).toBe(402);
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(await listKeys()).toEqual([]);
  });

  it("PAY-10 validation failure verifies but never settles", async () => {
    const res = await upload({ body: fixtures.zip, contentType: "application/zip" });
    expect(res.status).toBe(415);
    expect(facilitator.verifyCalls).toHaveLength(1);
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("PAY-11 a settled upload is written to the payment log", async () => {
    const logs = vi.spyOn(console, "log");
    const res = await upload();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; payment: { tx: string } };
    const entries = logs.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.kind === "payment");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: "upload", item_id: body.id, amount: "10000", tx: body.payment.tx, result: "settled" });
    expect(typeof entries[0].payer).toBe("string");
    logs.mockRestore();
  });

  it("PAY-12 a storage failure is 500 with feedback and no settle", async () => {
    testHooks.beforeStore = () => {
      throw new Error("R2 exploded");
    };
    const res = await upload();
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("internal_error");
    expect(body.feedback).toBe(`${API}/v1/feedback`);
    expect(JSON.stringify(body)).not.toContain("exploded");
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it("ERR-02 the 402 carries a PAYMENT-REQUIRED header a real x402 client can act on", async () => {
    // The paying fetch in helpers is the official client: if it can pay, the header is right.
    const res = await upload();
    expect(res.status).toBe(201);
  });
});

describe("idempotency (IDEM)", () => {
  async function signedUpload(body = fixtures.json, extraHeaders: Record<string, string> = {}) {
    const { signedHeaderFor } = await import("./helpers");
    const init = uploadInit({ body, headers: extraHeaders });
    const { header, payload } = await signedHeaderFor(uploadUrl(), init);
    const send = () => rawFetch(uploadUrl(), { ...init, headers: { ...(init.headers as Record<string, string>), "PAYMENT-SIGNATURE": header } });
    return { send, payload };
  }

  it("IDEM-01 the same signature twice returns the same item and settles once", async () => {
    const { send } = await signedUpload();
    const a = (await (await send()).json()) as Record<string, unknown>;
    const b = (await (await send()).json()) as Record<string, unknown>;
    expect(a.id).toBe(b.id);
    expect(a.secret).toBe(b.secret);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(await listKeys("items/")).toHaveLength(1);
  });

  it("IDEM-02 crash before settle, then retry with the same signature: one item, one settle", async () => {
    let crashed = false;
    testHooks.beforeSettle = () => {
      if (!crashed) {
        crashed = true;
        throw new Error("crash before settle");
      }
    };
    const { send } = await signedUpload();
    expect((await send()).status).toBe(500);
    expect(facilitator.settleCalls).toHaveLength(0);
    const retry = await send();
    expect(retry.status).toBe(201);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(await listKeys("items/")).toHaveLength(1);
  });

  it("IDEM-03 crash after settle, then retry: same id and secret, no second settle", async () => {
    let crashed = false;
    testHooks.afterSettle = () => {
      if (!crashed) {
        crashed = true;
        throw new Error("crash after settle");
      }
    };
    const { send } = await signedUpload();
    expect((await send()).status).toBe(500);
    expect(facilitator.settleCalls).toHaveLength(1);
    const retry = await send();
    expect(retry.status).toBe(201);
    const body = (await retry.json()) as Record<string, unknown>;
    expect(body.payment).toBeTruthy();
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("IDEM-04 IDEM-05 the record is written before settle and holds an encrypted secret", async () => {
    const { bucket } = await import("./helpers");
    let seen: string[] = [];
    testHooks.beforeSettle = async () => {
      seen = (await bucket().list({ prefix: "idem/" })).objects.map((o) => o.key);
    };
    const { send, payload } = await signedUpload();
    const res = await send();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; secret: string };
    const nonce = (payload.payload as Auth).authorization.nonce.toLowerCase();
    expect(seen.some((k) => k.endsWith(`/n_${nonce}`))).toBe(true);
    const rec = await (await bucket().get(seen[0]))!.text();
    expect(rec).toContain(body.id);
    expect(rec).not.toContain(body.secret);
  });

  it("IDEM-06 explicit key with a fresh signature returns the original item without a second settle", async () => {
    const a = await upload({ idempotencyKey: "k1", body: fixtures.json });
    const b = await upload({ idempotencyKey: "k1", body: fixtures.json });
    const ja = (await a.json()) as Record<string, unknown>;
    const jb = (await b.json()) as Record<string, unknown>;
    expect(b.status).toBe(201);
    expect(ja.id).toBe(jb.id);
    expect(ja.secret).toBe(jb.secret);
    expect(facilitator.settleCalls).toHaveLength(1);
    expect(facilitator.verifyCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("IDEM-07 same key, different body is 409 without settle", async () => {
    await upload({ idempotencyKey: "k2", body: fixtures.json });
    const res = await upload({ idempotencyKey: "k2", body: fixtures.txt, contentType: "text/plain" });
    await expectError(res, 409, "idempotency_conflict");
    expect(facilitator.settleCalls).toHaveLength(1);
  });

  it("IDEM-08 same key from another wallet is a new item", async () => {
    const a = (await (await upload({ idempotencyKey: "k3" })).json()) as Record<string, unknown>;
    const b = (await (await upload({ idempotencyKey: "k3", account: walletB })).json()) as Record<string, unknown>;
    expect(a.id).not.toBe(b.id);
    expect(facilitator.settleCalls).toHaveLength(2);
  });

  it("IDEM-09 guessing another wallet's key never leaks its secret", async () => {
    const a = (await (await upload({ idempotencyKey: "shared-key" })).json()) as Record<string, unknown>;
    const res = await upload({ idempotencyKey: "shared-key", account: walletB });
    const b = (await res.json()) as Record<string, unknown>;
    expect(b.secret).not.toBe(a.secret);
    expect(b.id).not.toBe(a.id);
  });
});
