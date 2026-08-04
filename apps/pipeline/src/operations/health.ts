import type { PipelineMetrics } from "./metrics.ts";

export interface ReadinessProbe {
  readonly name: "postgres" | "artifact_store";
  check(): Promise<void>;
}

export interface HealthState {
  readonly ok: boolean;
  readonly role: string;
  readonly state: "live" | "not_live" | "ready" | "not_ready";
  readonly checks?: Readonly<Record<string, "ok" | "failed">>;
}

export class PipelineHealth {
  #lastLoopProgressAt = Date.now();
  #claimLoopStopped = false;

  constructor(
    readonly role: string,
    private readonly probes: readonly ReadinessProbe[],
    private readonly stuckAfterMs = 60_000,
  ) {
    if (!role.trim()) throw new Error("Pipeline process role is required.");
    if (!Number.isSafeInteger(stuckAfterMs) || stuckAfterMs <= 0) throw new Error("Liveness threshold must be positive.");
  }

  markLoopProgress(now = Date.now()): void {
    this.#lastLoopProgressAt = now;
  }

  markClaimLoopStopped(): void {
    this.#claimLoopStopped = true;
  }

  liveness(now = Date.now()): HealthState {
    const ok = !this.#claimLoopStopped && now - this.#lastLoopProgressAt <= this.stuckAfterMs;
    return { ok, role: this.role, state: ok ? "live" : "not_live" };
  }

  async readiness(): Promise<HealthState> {
    const checks: Record<string, "ok" | "failed"> = {};
    await Promise.all(this.probes.map(async (probe) => {
      try {
        await probe.check();
        checks[probe.name] = "ok";
      } catch {
        checks[probe.name] = "failed";
      }
    }));
    const ok = this.liveness().ok && this.probes.every((probe) => checks[probe.name] === "ok");
    return { ok, role: this.role, state: ok ? "ready" : "not_ready", checks };
  }
}

export function startHealthServer(input: {
  readonly health: PipelineHealth;
  readonly metrics: PipelineMetrics;
  readonly port: number;
}): ReturnType<typeof Bun.serve> {
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("Pipeline health port must be between 1 and 65535.");
  }
  return Bun.serve({
    hostname: "0.0.0.0",
    port: input.port,
    routes: {
      "/live": () => jsonHealth(input.health.liveness()),
      "/ready": async () => jsonHealth(await input.health.readiness()),
      "/metrics": () => new Response(input.metrics.render(), {
        headers: { "content-type": "text/plain; version=0.0.4" },
      }),
    },
  });
}

function jsonHealth(state: HealthState): Response {
  return Response.json(state, { status: state.ok ? 200 : 503 });
}
