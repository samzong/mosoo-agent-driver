import { parseRuntimeEventEnvelope } from "../../runtime-events";
import type { RuntimeEventEnvelope, RuntimeEventInputDraft } from "../../runtime-events";

export type DriverEvent = RuntimeEventEnvelope;
export type DriverEventInput = RuntimeEventEnvelope | RuntimeEventInputDraft;

export interface DriverEventEnvelope {
  readonly event: DriverEvent;
  readonly eventId: string;
  readonly occurredAt?: number | null | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDriverEventEnvelope(input: unknown): DriverEventEnvelope {
  if (!isRecord(input)) {
    throw new TypeError("Driver event envelope must be an object.");
  }

  const eventId = input["eventId"];
  const occurredAt = input["occurredAt"];

  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new TypeError("Driver event envelope eventId must be a non-empty string.");
  }

  if (occurredAt !== undefined && occurredAt !== null && typeof occurredAt !== "number") {
    throw new TypeError("Driver event envelope occurredAt must be a number, null, or undefined.");
  }

  return {
    event: parseRuntimeEventEnvelope(input["event"]),
    eventId,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}
