import { summarizeDriverPermissionRequest } from "../infrastructure/logging/driver-debug";
import type { Logger } from "../observability";
import type { DriverEventInput } from "../protocol/events";
import { createPromiseDeferred, settlePromiseWithTimeout } from "../utils/async";
import { createDriverDiagnosticEvent } from "./driver-diagnostics";
import type { DriverRuntimeEventPort } from "./driver-runtime-io";

const PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export type PermissionDecision = "allow_once" | "reject_once";
export type PermissionResolutionReason = "approved" | "cancelled" | "rejected" | "timed_out";

interface PermissionResolution {
  decision: PermissionDecision;
  reason: PermissionResolutionReason;
}

export interface DriverPermissionRequest {
  rawInput: string | null;
  requestId: string;
  title: string;
  toolCallId: string | null;
  toolKind: string | null;
}

export interface DriverPermissionBrokerOptions {
  interactiveRequests?: boolean;
  requestTimeoutMs?: number;
}

export class DriverPermissionBroker {
  readonly #interactiveRequests: boolean;
  readonly #logger: () => Logger | null;
  readonly #requestTimeoutMs: number;
  readonly #resolvers = new Map<string, (resolution: PermissionResolution) => void>();

  constructor(logger: () => Logger | null, options: DriverPermissionBrokerOptions = {}) {
    this.#interactiveRequests = options.interactiveRequests ?? true;
    this.#logger = logger;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? PERMISSION_REQUEST_TIMEOUT_MS;
  }

  capabilityStatus(): "supported" | "unsupported" {
    return this.#interactiveRequests ? "supported" : "unsupported";
  }

  resolve(requestId: string, decision: PermissionDecision): boolean {
    return this.resolveRequest(requestId, {
      decision,
      reason: decision === "allow_once" ? "approved" : "rejected",
    });
  }

  rejectAll(reason: PermissionResolutionReason = "cancelled"): void {
    for (const requestId of this.#resolvers.keys()) {
      this.resolveRequest(requestId, {
        decision: "reject_once",
        reason,
      });
    }
  }

  private resolveRequest(requestId: string, resolution: PermissionResolution): boolean {
    const resolve = this.#resolvers.get(requestId);

    if (!resolve) {
      return false;
    }

    this.#resolvers.delete(requestId);
    resolve(resolution);
    return true;
  }

  async request(
    socket: DriverRuntimeEventPort,
    input: DriverPermissionRequest,
  ): Promise<PermissionDecision> {
    if (!this.#interactiveRequests) {
      this.#logger()?.debug("driver.runtime.permission.request.rejected", {
        ...summarizeDriverPermissionRequest(input),
        reason: "interactive_permission_unsupported",
      });
      return "reject_once";
    }

    const events: DriverEventInput[] = [
      {
        kind: "permission.requested",
        payload: {
          details: input.rawInput,
          options: [],
          requestId: input.requestId,
          targetItemId: input.toolCallId,
          title: input.title,
          toolCall: {
            kind: input.toolKind,
            toolCallId: input.toolCallId,
          },
        },
      },
    ];
    const deferred = createPromiseDeferred<PermissionResolution>();
    this.#resolvers.set(input.requestId, deferred.resolve);

    try {
      this.#logger()?.debug("driver.runtime.permission.request.sending", {
        ...summarizeDriverPermissionRequest(input),
        timeoutMs: this.#requestTimeoutMs,
      });

      await socket.pushEvents({ events });
      this.#logger()?.debug("driver.runtime.permission.request.sent", {
        requestId: input.requestId,
        timeoutMs: this.#requestTimeoutMs,
        toolCallId: input.toolCallId,
        toolKind: input.toolKind,
      });

      const result = await settlePromiseWithTimeout(deferred.promise, {
        label: `Driver permission request ${input.requestId}`,
        timeoutMs: this.#requestTimeoutMs,
      });

      if (result.status === "failed") {
        throw result.error;
      }

      const resolution: PermissionResolution =
        result.status === "timed_out"
          ? { decision: "reject_once", reason: "timed_out" }
          : result.value;
      const decision = resolution.decision;

      if (result.status === "timed_out") {
        this.#logger()?.debug("driver.runtime.permission.request.timed_out", {
          requestId: input.requestId,
          timeoutMs: this.#requestTimeoutMs,
        });
      }

      await socket.pushEvents({
        events: [
          {
            kind: "permission.resolved",
            payload: {
              outcome: decision,
              permissionRequests: [],
              reason: resolution.reason,
              requestId: input.requestId,
            },
          },
          ...createPermissionResolutionDiagnosticEvents(input, resolution.reason),
        ],
      });

      this.#logger()?.debug("driver.runtime.permission.request.resolved", {
        decision,
        reason: resolution.reason,
        requestId: input.requestId,
      });

      return decision;
    } finally {
      this.#resolvers.delete(input.requestId);
    }
  }
}

function createPermissionResolutionDiagnosticEvents(
  input: DriverPermissionRequest,
  reason: PermissionResolutionReason,
): DriverEventInput[] {
  if (reason !== "cancelled" && reason !== "timed_out") {
    return [];
  }

  return [
    createDriverDiagnosticEvent({
      code: reason === "cancelled" ? "permission.cancelled" : "permission.timed_out",
      details: {
        requestId: input.requestId,
        toolCallId: input.toolCallId,
        toolKind: input.toolKind,
      },
      message:
        reason === "cancelled"
          ? "Permission request was cancelled."
          : "Permission request timed out.",
      reason,
      severity: reason === "cancelled" ? "info" : "warn",
      source: "permission",
    }),
  ];
}
