export interface ErrorAction {
  description: string;
  method?: string;
  url?: string;
}

export type ErrorCode =
  | "payment_required"
  | "reads_exhausted"
  | "not_found"
  | "invalid_request"
  | "idempotency_conflict"
  | "too_large"
  | "unsupported_type"
  | "locked"
  | "rate_limited"
  | "method_not_allowed"
  | "internal_error";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly action?: ErrorAction,
    public readonly extra?: Record<string, unknown>,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export interface ErrorBody {
  error: ErrorCode;
  message: string;
  action?: ErrorAction;
  request_id: string;
  docs: string;
  feedback: string;
  [key: string]: unknown;
}

export function errorBody(err: ApiError, requestId: string, apiOrigin: string): ErrorBody {
  return {
    error: err.code,
    message: err.message,
    ...(err.action ? { action: err.action } : {}),
    ...(err.extra ?? {}),
    request_id: requestId,
    docs: `${apiOrigin}/llms.txt`,
    feedback: `${apiOrigin}/v1/feedback`,
  };
}

/** The one response used for every "no access" case, so nothing leaks. */
export function notFound(): ApiError {
  return new ApiError(404, "not_found", "Item not available: it does not exist, has expired, or the credentials are wrong.", {
    description: "If you are the owner, upload the content again. Secrets and passwords cannot be recovered.",
  });
}
