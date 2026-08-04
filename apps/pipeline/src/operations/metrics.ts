const SAFE_LABEL = /^[a-zA-Z0-9_.:@/-]{1,255}$/;
const SENSITIVE_LABEL_KEY = /(url|uri|content|text|question|token|secret|password|authorization|credential|cookie)/i;

export type PipelineMetricName =
  | "pipeline_source_freshness_seconds"
  | "pipeline_queue_age_seconds"
  | "pipeline_stage_duration_seconds"
  | "pipeline_retries_total"
  | "pipeline_dead_letters_total"
  | "pipeline_lease_recoveries_total"
  | "pipeline_review_backlog"
  | "pipeline_publication_lag_seconds";

export type MetricLabels = Readonly<Record<string, string>>;

interface MetricSample {
  readonly value: number;
  readonly labels: MetricLabels;
}

/** Small dependency-free Prometheus registry for the worker control plane. */
export class PipelineMetrics {
  readonly #samples = new Map<PipelineMetricName, Map<string, MetricSample>>();

  set(name: PipelineMetricName, value: number, labels: MetricLabels = {}): void {
    assertMetricValue(value);
    const normalized = validateLabels(labels);
    const key = JSON.stringify(Object.entries(normalized));
    const metric = this.#samples.get(name) ?? new Map<string, MetricSample>();
    metric.set(key, { value, labels: normalized });
    this.#samples.set(name, metric);
  }

  increment(name: PipelineMetricName, labels: MetricLabels = {}, amount = 1): void {
    assertMetricValue(amount);
    const normalized = validateLabels(labels);
    const key = JSON.stringify(Object.entries(normalized));
    const metric = this.#samples.get(name) ?? new Map<string, MetricSample>();
    const current = metric.get(key)?.value ?? 0;
    metric.set(key, { value: current + amount, labels: normalized });
    this.#samples.set(name, metric);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, samples] of [...this.#samples].sort(([left], [right]) => left.localeCompare(right))) {
      for (const sample of samples.values()) {
        const labels = Object.entries(sample.labels)
          .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
          .join(",");
        lines.push(`${name}${labels ? `{${labels}}` : ""} ${sample.value}`);
      }
    }
    return `${lines.join("\n")}${lines.length ? "\n" : ""}`;
  }
}

export interface PipelineLogContext {
  readonly correlationId: string;
  readonly sourceId?: string;
  readonly documentVersionId?: string;
  readonly pipelineRunId?: string;
  readonly stageAttemptId?: string;
}

export function structuredPipelineLog(
  level: "info" | "warn" | "error",
  event: string,
  context: PipelineLogContext,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
): string {
  if (!event.trim() || SENSITIVE_LABEL_KEY.test(event)) throw new Error("Pipeline log event is unsafe.");
  validateLabels(Object.fromEntries(
    Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ));
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_LABEL_KEY.test(key)) throw new Error(`Sensitive pipeline log field is forbidden: ${key}.`);
    if (typeof value === "string" && !SAFE_LABEL.test(value)) throw new Error(`Pipeline log field ${key} is not an opaque value.`);
  }
  return JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...context, ...fields });
}

function validateLabels(labels: MetricLabels): Record<string, string> {
  const normalized = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of normalized) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || SENSITIVE_LABEL_KEY.test(key)) {
      throw new Error(`Sensitive or invalid metric label is forbidden: ${key}.`);
    }
    if (!SAFE_LABEL.test(value) || /^https?:/i.test(value)) {
      throw new Error(`Metric label ${key} must be an opaque identifier.`);
    }
  }
  return Object.fromEntries(normalized);
}

function assertMetricValue(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("Metric values must be finite and non-negative.");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
