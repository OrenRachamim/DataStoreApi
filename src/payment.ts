import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { authorizationTypes } from "@x402/evm";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import type { Config } from "./env";

export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export interface ParsedPayment {
  payload: PaymentPayload;
  /** Checksummed address recovered from the signature. */
  payer: string;
  nonce: string;
  amount: string;
  validBefore: number;
}

export class PaymentError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Test hook: when set, replaces the HTTP facilitator client. */
let facilitatorOverride: FacilitatorClient | undefined;
export function setFacilitatorForTests(client: FacilitatorClient | undefined): void {
  facilitatorOverride = client;
  servers.clear();
}

/**
 * Initialized servers, cached per isolate. Only a *finished* initialization is cached:
 * a pending promise created inside one request must never be awaited by another, because
 * Workers cancel a request's I/O and timers when that request ends, and a promise stranded
 * that way never settles and would hang every later request on the isolate.
 */
const servers = new Map<string, x402ResourceServer>();

/**
 * A fresh isolate must learn the facilitator's supported kinds before it can build a 402.
 * That single fetch occasionally stalls; the x402 client would wait 30 s. So each attempt
 * gets its own server object and a short deadline, and a stalled attempt is abandoned.
 */
export const FACILITATOR_INIT_TIMEOUT_MS = 5_000;
export const FACILITATOR_INIT_ATTEMPTS = 3;

async function initializeServer(config: Config, cdp?: { apiKeyId?: string; apiKeySecret?: string }): Promise<x402ResourceServer> {
  const network = config.network as `${string}:${string}`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= FACILITATOR_INIT_ATTEMPTS; attempt++) {
    const client = facilitatorOverride ?? facilitatorClientFor(config, cdp);
    const server = new x402ResourceServer(client).register(network, new ExactEvmScheme());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), FACILITATOR_INIT_TIMEOUT_MS);
    });
    // initialize() swallows facilitator errors, so check the outcome rather than trust it.
    const outcome = await Promise.race([server.initialize().then(() => "done" as const, (err: unknown) => ({ err })), deadline]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "done" && server.getSupportedKind(2, network, "exact")) return server;
    lastError = outcome === "timeout" ? new Error(`facilitator initialization timed out after ${FACILITATOR_INIT_TIMEOUT_MS} ms`) : outcome === "done" ? new Error(`facilitator does not support exact on ${network}`) : outcome.err;
    console.warn(JSON.stringify({ kind: "system", event: "facilitator_init_failed", attempt, error: String((lastError as Error)?.message ?? lastError) }));
  }
  throw lastError;
}

async function serverFor(config: Config, cdp?: { apiKeyId?: string; apiKeySecret?: string }): Promise<x402ResourceServer> {
  const key = `${config.facilitatorUrl}|${config.network}`;
  const cached = servers.get(key);
  if (cached) return cached;
  const server = await initializeServer(config, cdp);
  servers.set(key, server);
  return server;
}

/**
 * Facilitator HTTP client. With CDP API keys (mainnet) the Coinbase facilitator
 * requires signed auth headers; the public testnet facilitator needs none.
 */
export function facilitatorClientFor(config: Config, cdp?: { apiKeyId?: string; apiKeySecret?: string }): HTTPFacilitatorClient {
  if (cdp?.apiKeyId && cdp.apiKeySecret) {
    const fc = createFacilitatorConfig(cdp.apiKeyId, cdp.apiKeySecret);
    return new HTTPFacilitatorClient({ ...fc, url: config.facilitatorUrl || fc.url });
  }
  return new HTTPFacilitatorClient({ url: config.facilitatorUrl });
}

export interface PaymentService {
  requirements(resourceUrl: string, timeoutSeconds: number): Promise<PaymentRequirements[]>;
  paymentRequired(resourceUrl: string, description: string, timeoutSeconds: number, error?: string): Promise<{ header: string; body: PaymentRequired }>;
  parse(header: string, requirements: PaymentRequirements[]): Promise<{ parsed: ParsedPayment; matched: PaymentRequirements }>;
  verify(parsed: ParsedPayment, matched: PaymentRequirements): Promise<void>;
  settle(parsed: ParsedPayment, matched: PaymentRequirements): Promise<SettleResponse>;
  responseHeader(settle: SettleResponse): string;
}

export function createPaymentService(config: Config, cdp?: { apiKeyId?: string; apiKeySecret?: string }): PaymentService {
  // Resolved on first use, inside the request that needs it.
  let ready: Promise<x402ResourceServer> | undefined;
  const getServer = (): Promise<x402ResourceServer> => (ready ??= serverFor(config, cdp));

  const requirements = async (resourceUrl: string, timeoutSeconds: number): Promise<PaymentRequirements[]> => {
    const server = await getServer();
    return server.buildPaymentRequirementsFromOptions(
      [
        {
          scheme: "exact",
          payTo: config.payTo,
          price: `$${config.priceUsd}`,
          network: config.network as `${string}:${string}`,
          maxTimeoutSeconds: timeoutSeconds,
        },
      ],
      { resourceUrl },
    );
  };

  return {
    requirements,

    async paymentRequired(resourceUrl, description, timeoutSeconds, error) {
      const reqs = await requirements(resourceUrl, timeoutSeconds);
      const server = await getServer();
      const body = await server.createPaymentRequiredResponse(
        reqs,
        { url: resourceUrl, description, mimeType: "application/json", serviceName: config.serviceName },
        error,
      );
      return { header: encodePaymentRequiredHeader(body), body };
    },

    async parse(header, reqs) {
      let payload: PaymentPayload;
      try {
        payload = decodePaymentSignatureHeader(header);
      } catch {
        throw new PaymentError("invalid_payment_header", "The payment header could not be decoded.");
      }
      if (payload.x402Version !== 2) throw new PaymentError("unsupported_version", "Only x402 version 2 is supported.");
      const server = await getServer();
      const matched = server.findMatchingRequirements(reqs, payload);
      if (!matched) throw new PaymentError("requirements_mismatch", "The payment does not match this resource's requirements (amount, asset, network or recipient).");

      const auth = (payload.payload as { authorization?: Record<string, string>; signature?: string }).authorization;
      const signature = (payload.payload as { signature?: string }).signature;
      if (!auth || !signature) throw new PaymentError("invalid_payment_payload", "Only EIP-3009 authorizations are supported.");

      const chainId = Number.parseInt(matched.network.split(":")[1], 10);
      const extra = matched.extra as { name?: string; version?: string };
      let recovered: string;
      try {
        recovered = await recoverTypedDataAddress({
          domain: { name: extra.name, version: extra.version, chainId, verifyingContract: getAddress(matched.asset) },
          types: authorizationTypes,
          primaryType: "TransferWithAuthorization",
          message: {
            from: getAddress(auth.from),
            to: getAddress(auth.to),
            value: BigInt(auth.value),
            validAfter: BigInt(auth.validAfter),
            validBefore: BigInt(auth.validBefore),
            nonce: auth.nonce as Hex,
          },
          signature: signature as Hex,
        });
      } catch {
        throw new PaymentError("invalid_signature", "The payment signature could not be verified.");
      }
      if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
        throw new PaymentError("invalid_signature", "The payment signature does not belong to the declared payer.");
      }
      return {
        parsed: { payload, payer: getAddress(recovered), nonce: auth.nonce, amount: auth.value, validBefore: Number(auth.validBefore) },
        matched,
      };
    },

    async verify(parsed, matched) {
      const server = await getServer();
      let res;
      try {
        res = await server.verifyPayment(parsed.payload, matched);
      } catch (err) {
        // The facilitator timed out or is unreachable. Nothing was charged, so this is a
        // 402 the client can answer with a fresh payment, not an internal error.
        throw new PaymentError("facilitator_unavailable", `The payment facilitator did not answer: ${String((err as Error)?.message ?? err)}`);
      }
      if (!res.isValid) throw new PaymentError(res.invalidReason ?? "verification_failed", res.invalidMessage ?? "Payment verification failed.");
    },

    async settle(parsed, matched) {
      const server = await getServer();
      const res = await server.settlePayment(parsed.payload, matched);
      if (!res.success) throw new PaymentError(res.errorReason ?? "settlement_failed", res.errorMessage ?? "Payment settlement failed.");
      return res;
    },

    responseHeader(settle) {
      return encodePaymentResponseHeader(settle);
    },
  };
}
