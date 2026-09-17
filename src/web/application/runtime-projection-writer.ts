import type {
  ApplicationLifecycle,
  PrimaryRuntimeReadiness,
} from "../../shared/types";
import { acceptApplicationLifecycle } from "./application-lifecycle";
import {
  acceptPrimaryReadiness,
  type PrimaryCapabilitySnapshot,
} from "./runtime-readiness";

export type RuntimeProjectionWriteAuthority = {
  runEpochGeneration: number;
  runtimeProjectionGeneration: number;
};

export type RuntimeProjectionSinks = {
  readiness: (next: PrimaryRuntimeReadiness) => void;
  capability: (next: PrimaryCapabilitySnapshot | null) => void;
  lifecycle: (next: ApplicationLifecycle) => void;
};

export type RuntimeReadinessTransition = {
  previous: PrimaryRuntimeReadiness;
  next: PrimaryRuntimeReadiness;
  committed: boolean;
};

type BootstrapRuntimeProjection = {
  readiness: PrimaryRuntimeReadiness;
  lifecycle: unknown;
};

type BootstrapCapabilityEvidence = {
  readiness: PrimaryRuntimeReadiness | undefined;
  committedModelKey: string;
  modelKeys: string[];
};

function acceptsReadinessObservation(
  current: PrimaryRuntimeReadiness,
  incoming: PrimaryRuntimeReadiness,
): boolean {
  if (incoming.generation > current.generation) return true;
  if (incoming.generation < current.generation) return false;
  return !(incoming.status === "starting" && current.status !== "starting");
}

function sameReadiness(
  left: PrimaryRuntimeReadiness,
  right: PrimaryRuntimeReadiness,
): boolean {
  return left.status === right.status
    && left.generation === right.generation
    && left.error === right.error
    && left.incidentId === right.incidentId
    && left.thinkingLevel === right.thinkingLevel
    && left.sessionId === right.sessionId
    && JSON.stringify(left.model) === JSON.stringify(right.model);
}

function sameCapability(
  left: PrimaryCapabilitySnapshot | null,
  right: PrimaryCapabilitySnapshot | null,
): boolean {
  return left === right || Boolean(
    left && right
      && left.generation === right.generation
      && left.modelKeys.length === right.modelKeys.length
      && left.modelKeys.every((key, index) => key === right.modelKeys[index]),
  );
}

/**
 * Sole write and freshness boundary for browser Primary Runtime lifecycle state.
 *
 * Session/pane facts remain with their existing owners. Async Runtime metadata
 * must carry authority captured before its request; admitted SSE observations
 * use the current projection generation synchronously.
 */
export class RuntimeProjectionWriter {
  private projectionGeneration = 0;
  private readiness: PrimaryRuntimeReadiness = {
    status: "starting",
    generation: 0,
  };
  private capability: PrimaryCapabilitySnapshot | null = null;
  private lifecycle: ApplicationLifecycle = "idle";

  constructor(
    private readonly sinks: RuntimeProjectionSinks,
    private readonly currentRunEpochGeneration: () => number,
  ) {}

  captureAuthority(
    runEpochGeneration: number,
  ): RuntimeProjectionWriteAuthority {
    return {
      runEpochGeneration,
      runtimeProjectionGeneration: this.projectionGeneration,
    };
  }

  isCurrent(authority: RuntimeProjectionWriteAuthority): boolean {
    return authority.runEpochGeneration === this.currentRunEpochGeneration()
      && authority.runtimeProjectionGeneration === this.projectionGeneration;
  }

  currentReadiness(): PrimaryRuntimeReadiness {
    return this.readiness;
  }

  currentCapability(): PrimaryCapabilitySnapshot | null {
    return this.capability;
  }

  currentLifecycle(): ApplicationLifecycle {
    return this.lifecycle;
  }

  commitBootstrap(
    projection: BootstrapRuntimeProjection,
    authority: RuntimeProjectionWriteAuthority,
  ): boolean {
    if (
      !this.isCurrent(authority)
      || !acceptsReadinessObservation(this.readiness, projection.readiness)
    ) return false;
    this.writeReadiness(
      acceptPrimaryReadiness(this.readiness, projection.readiness),
    );
    this.writeLifecycle(
      acceptApplicationLifecycle(this.lifecycle, projection.lifecycle),
    );
    return true;
  }

  confirmBootstrapCapability(
    evidence: BootstrapCapabilityEvidence,
    authority: RuntimeProjectionWriteAuthority,
  ): boolean {
    if (!this.isCurrent(authority)) return false;
    if (
      evidence.readiness?.status !== "ready"
      || this.readiness.status !== "ready"
      || evidence.readiness.generation !== this.readiness.generation
      || !evidence.committedModelKey
      || !evidence.modelKeys.includes(evidence.committedModelKey)
    ) return false;
    this.writeCapability({
      generation: evidence.readiness.generation,
      modelKeys: [...new Set(evidence.modelKeys)],
    });
    return true;
  }

  observeTransportReady(
    incoming: PrimaryRuntimeReadiness,
  ): RuntimeReadinessTransition {
    const previous = this.readiness;
    const next = acceptPrimaryReadiness(previous, incoming);
    const committed = !sameReadiness(previous, next);
    if (committed) {
      this.projectionGeneration += 1;
      this.writeReadiness(next);
    }
    return { previous, next, committed };
  }

  observeRuntimeStatus(
    incoming: PrimaryRuntimeReadiness,
  ): RuntimeReadinessTransition {
    const previous = this.readiness;
    const next = acceptPrimaryReadiness(previous, incoming);
    const committed = !sameReadiness(previous, next);
    if (committed) {
      this.projectionGeneration += 1;
      this.writeReadiness(next);
    }
    return { previous, next, committed };
  }

  observeLifecycle(incoming: unknown): ApplicationLifecycle {
    const next = acceptApplicationLifecycle(this.lifecycle, incoming);
    if (next !== this.lifecycle) {
      this.projectionGeneration += 1;
      this.writeLifecycle(next);
    }
    return next;
  }

  publishReadyCapability(
    snapshot: PrimaryCapabilitySnapshot,
  ): boolean {
    if (
      this.readiness.status !== "ready"
      || snapshot.generation !== this.readiness.generation
    ) return false;
    if (!sameCapability(this.capability, snapshot)) {
      this.projectionGeneration += 1;
      this.writeCapability(snapshot);
    }
    return true;
  }

  resetForResourceReload(): void {
    this.projectionGeneration += 1;
    this.writeReadiness({
      status: "starting",
      generation: this.readiness.generation,
    });
  }

  resetForProcessReplacement(): void {
    this.projectionGeneration += 1;
    this.writeReadiness({ status: "starting", generation: 0 });
  }

  private writeReadiness(next: PrimaryRuntimeReadiness): void {
    this.readiness = next;
    this.sinks.readiness(next);
    if (
      this.capability
      && (next.status !== "ready"
        || this.capability.generation !== next.generation)
    ) this.writeCapability(null);
  }

  private writeCapability(next: PrimaryCapabilitySnapshot | null): void {
    this.capability = next;
    this.sinks.capability(next);
  }

  private writeLifecycle(next: ApplicationLifecycle): void {
    this.lifecycle = next;
    this.sinks.lifecycle(next);
  }
}
