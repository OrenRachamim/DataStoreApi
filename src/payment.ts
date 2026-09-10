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

const servers = new Map<string, { server: x402ResourceServer; ready: Promise<void> }>();

function serverFor(config: Config, cdp?: { apiKeyId?: string; apiKeySecret?: string }): { server: x402ResourceServer; ready: Promise<void> } {
  const key = `${config.facilitatorUrl}|${config.network}`;
  let entry = servers.get(key);
  if (!entry) {
    const client = facilitatorOverride ?? facilitatorClientFor(config, cdp);
    const server = new x402ResourceServer(client).register(config.network as `${string}:${string}`, new ExactEvmScheme());
    const ready = server.initialize().catch((err) => {
      servers.delete(key);
      throw err;
    });
    entry = { server, ready };
    servers.set(key, entry);
  }
  return entry;
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
  const { server, ready } = serverFor(config, cdp);

  const requirements = async (resourceUrl: string, timeoutSeconds: number): Promise<PaymentRequirements[]> => {
    await ready;
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
      await ready;
      const res = await server.verifyPayment(parsed.payload, matched);
      if (!res.isValid) throw new PaymentError(res.invalidReason ?? "verification_failed", res.invalidMessage ?? "Payment verification failed.");
    },

    async settle(parsed, matched) {
      await ready;
      const res = await server.settlePayment(parsed.payload, matched);
      if (!res.success) throw new PaymentError(res.errorReason ?? "settlement_failed", res.errorMessage ?? "Payment settlement failed.");
      return res;
    },

    responseHeader(settle) {
      return encodePaymentResponseHeader(settle);
    },
  };
}
