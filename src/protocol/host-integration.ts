import type {
  DriverConfigRevision,
  DriverExecutionSessionContext,
  DriverExecutionSpec,
} from "./boot";

export interface DriverHostIntegrationSnapshot {
  readonly configRevision: DriverConfigRevision;
  readonly sessionContext: DriverExecutionSessionContext;
}

export function createDriverHostIntegrationSnapshotFromBootExecution(
  execution: DriverExecutionSpec,
): DriverHostIntegrationSnapshot {
  return {
    configRevision: execution.configRevision,
    sessionContext: execution.session.context,
  };
}
