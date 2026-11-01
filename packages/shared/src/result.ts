/** Explicit result type. Engines never throw for expected domain failures. */
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export type DomainErrorCode =
  | "validation_failed"
  | "not_found"
  | "forbidden"
  | "unauthenticated"
  | "conflict"
  | "rate_limited"
  | "payload_too_large"
  | "entitlement_exceeded"
  | "insufficient_data"
  | "integration_unavailable"
  | "integration_error"
  | "not_configured";

export interface DomainError {
  code: DomainErrorCode;
  message: string;
  /** Machine-readable detail. Never contains secrets or raw credentials. */
  detail?: Record<string, unknown>;
}

export const domainError = (
  code: DomainErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): DomainError => (detail === undefined ? { code, message } : { code, message, detail });

/** HTTP status mapping used by every route handler, so responses stay consistent. */
export const statusForError = (code: DomainErrorCode): number =>
  ({
    validation_failed: 400,
    not_found: 404,
    forbidden: 403,
    unauthenticated: 401,
    conflict: 409,
    rate_limited: 429,
    payload_too_large: 413,
    entitlement_exceeded: 402,
    insufficient_data: 422,
    integration_unavailable: 503,
    integration_error: 502,
    not_configured: 501,
  })[code];
