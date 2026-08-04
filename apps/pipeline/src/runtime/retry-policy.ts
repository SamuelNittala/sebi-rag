export type StageFailureClassification = "transient" | "deterministic";

export interface ClassifiedStageFailure {
  readonly classification: StageFailureClassification;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface RetryPolicy {
  classify(error: unknown): ClassifiedStageFailure;
  delayMs(attemptNumber: number): number;
}

export interface RetryPolicyOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export class StageExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly classification: StageFailureClassification,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StageExecutionError";
  }
}

export class TransientStageError extends StageExecutionError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, "transient", message, options);
    this.name = "TransientStageError";
  }
}

export class DeterministicStageError extends StageExecutionError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, "deterministic", message, options);
    this.name = "DeterministicStageError";
  }
}

export function createRetryPolicy(options: RetryPolicyOptions = {}): RetryPolicy {
  const baseDelayMs = positiveInteger(options.baseDelayMs ?? 1_000, "Base retry delay");
  const maxDelayMs = positiveInteger(options.maxDelayMs ?? 15 * 60_000, "Maximum retry delay");
  if (baseDelayMs > maxDelayMs) throw new Error("Base retry delay cannot exceed maximum retry delay.");

  return {
    classify(error): ClassifiedStageFailure {
      if (error instanceof StageExecutionError) {
        return {
          classification: error.classification,
          errorCode: error.code,
          errorMessage: error.message,
        };
      }
      if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return { classification: "transient", errorCode: error.name.toUpperCase(), errorMessage: error.message };
      }
      const transientShape = classifyTransientShape(error);
      if (transientShape) return transientShape;
      if (error instanceof TypeError && /fetch|network|socket|connection/i.test(error.message)) {
        return { classification: "transient", errorCode: "NETWORK_ERROR", errorMessage: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { classification: "deterministic", errorCode: "UNCLASSIFIED_STAGE_ERROR", errorMessage: message };
    },
    delayMs(attemptNumber): number {
      const attempt = positiveInteger(attemptNumber, "Attempt number");
      return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 20));
    },
  };
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
]);

function classifyTransientShape(error: unknown): ClassifiedStageFailure | null {
  if (!error || typeof error !== "object") return null;
  const message = error instanceof Error ? error.message : String(error);
  const record = error as Record<string, unknown>;
  const code = Object.hasOwn(record, "code") && typeof record.code === "string" ? record.code : null;
  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return { classification: "transient", errorCode: code, errorMessage: message };
  }

  const directStatus = Object.hasOwn(record, "status") && typeof record.status === "number"
    ? record.status
    : null;
  const metadata = Object.hasOwn(record, "$metadata") && record.$metadata && typeof record.$metadata === "object"
    ? record.$metadata as Record<string, unknown>
    : null;
  const metadataStatus = metadata && Object.hasOwn(metadata, "httpStatusCode")
    && typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : null;
  const status = directStatus ?? metadataStatus;
  if (status === 408 || status === 429 || (status !== null && status >= 500 && status <= 599)) {
    return { classification: "transient", errorCode: `HTTP_${status}`, errorMessage: message };
  }
  return null;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}
