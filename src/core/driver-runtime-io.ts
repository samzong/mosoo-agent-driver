import type { DriverEventInput } from "../protocol/events";
import type { RunId } from "../protocol/id";
import type {
  DriverFailureInput,
  DriverHeartbeatInput,
  DriverHeartbeatOutput,
} from "../protocol/orpc";
import type { RunError, RuntimeCommand, RuntimeCommandResult } from "../runtime-command";

export interface DriverRuntimeEventPort {
  pushEvents(input: { events: DriverEventInput[] }): Promise<void>;
}

export interface DriverRuntimeCommandPort {
  commandUpdate(input: {
    commandId: string;
    error?: RunError;
    result?: RuntimeCommandResult;
    status: "accepted" | "cancelled" | "completed" | "failed";
  }): Promise<void>;
  nextCommand(): Promise<RuntimeCommand | null>;
}

export interface DriverRuntimeRunPort {
  beginRun(runId: RunId): void;
  completeRun(): Promise<void>;
  endRun(runId: RunId): void;
  failRun(error: DriverFailureInput["error"]): Promise<void>;
}

export interface DriverRuntimeHeartbeatPort {
  heartbeat(input: Omit<DriverHeartbeatInput, "pid">): Promise<DriverHeartbeatOutput>;
}

export interface DriverRuntimeIo
  extends
    DriverRuntimeCommandPort,
    DriverRuntimeEventPort,
    DriverRuntimeHeartbeatPort,
    DriverRuntimeRunPort {}
