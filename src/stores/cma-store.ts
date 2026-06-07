import type { CmaInboundEvent, CmaOutboundEvent, CmaSessionStatus } from "../projections/cma";
import type { DriverEventInput } from "../protocol/events";
import type { RuntimeCommand, RuntimeCommandResult } from "../runtime-command";

export type CmaStoreResourceKind = "agent" | "environment" | "event" | "session";

export class CmaStoreConflictError extends Error {
  readonly id: string;
  readonly resource: CmaStoreResourceKind;

  constructor(resource: CmaStoreResourceKind, id: string) {
    super(`CMA ${resource} already exists: ${id}.`);
    this.name = "CmaStoreConflictError";
    this.resource = resource;
    this.id = id;
  }
}

export class CmaStoreNotFoundError extends Error {
  readonly id: string;
  readonly resource: CmaStoreResourceKind;

  constructor(resource: CmaStoreResourceKind, id: string) {
    super(`CMA ${resource} was not found: ${id}.`);
    this.name = "CmaStoreNotFoundError";
    this.resource = resource;
    this.id = id;
  }
}

export interface CmaAgentRecord {
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: Record<string, unknown>;
  readonly name: string;
  readonly updatedAt: string;
}

export type CmaEnvironmentPackageManager = "apt" | "cargo" | "gem" | "go" | "npm" | "pip";

export type CmaEnvironmentPackages = Partial<
  Record<CmaEnvironmentPackageManager, readonly string[]>
>;

export interface CmaEnvironmentUnrestrictedNetworking {
  readonly type: "unrestricted";
}

export interface CmaEnvironmentLimitedNetworking {
  readonly allow_mcp_servers: boolean;
  readonly allow_package_managers: boolean;
  readonly allowed_hosts: readonly string[];
  readonly type: "limited";
}

export type CmaEnvironmentNetworking =
  | CmaEnvironmentLimitedNetworking
  | CmaEnvironmentUnrestrictedNetworking;

export interface CmaEnvironmentConfig {
  readonly networking: CmaEnvironmentNetworking;
  readonly packages: CmaEnvironmentPackages;
  readonly type: "cloud";
}

export interface CmaEnvironmentRecord {
  readonly archivedAt: string | null;
  readonly config: CmaEnvironmentConfig;
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: Record<string, unknown>;
  readonly name: string;
  readonly updatedAt: string;
}

export interface CmaSessionRecord {
  readonly agentId: string | null;
  readonly createdAt: string;
  readonly environmentId: string | null;
  readonly id: string;
  readonly metadata: Record<string, unknown>;
  readonly status: CmaSessionStatus;
  readonly updatedAt: string;
}

export interface CmaSessionEventRecord {
  readonly command: RuntimeCommand | null;
  readonly commandResult: RuntimeCommandResult | null;
  readonly createdAt: string;
  readonly direction: "inbound" | "outbound";
  readonly driverEvent: DriverEventInput | null;
  readonly event: CmaInboundEvent | CmaOutboundEvent;
  readonly id: string;
  readonly sessionId: string;
}

export interface CmaCreateAgentInput {
  readonly id?: string;
  readonly metadata?: Record<string, unknown>;
  readonly name: string;
}

export interface CmaCreateEnvironmentInput {
  readonly config?: CmaEnvironmentConfig;
  readonly id?: string;
  readonly metadata?: Record<string, unknown>;
  readonly name: string;
}

export interface CmaCreateSessionInput {
  readonly agentId?: string;
  readonly environmentId?: string;
  readonly id?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CmaAppendInboundEventInput {
  readonly command: RuntimeCommand;
  readonly commandResult: RuntimeCommandResult | null;
  readonly event: CmaInboundEvent;
  readonly sessionId: string;
}

export interface CmaStore {
  appendDriverEvent(
    sessionId: string,
    driverEvent: DriverEventInput,
  ): Promise<readonly CmaSessionEventRecord[]>;
  appendInboundEvent(input: CmaAppendInboundEventInput): Promise<CmaSessionEventRecord>;
  archiveEnvironment(id: string): Promise<CmaEnvironmentRecord>;
  createAgent(input: CmaCreateAgentInput): Promise<CmaAgentRecord>;
  createEnvironment(input: CmaCreateEnvironmentInput): Promise<CmaEnvironmentRecord>;
  createSession(input: CmaCreateSessionInput): Promise<CmaSessionRecord>;
  deleteEnvironment(id: string): Promise<boolean>;
  getAgent(id: string): Promise<CmaAgentRecord | null>;
  getEnvironment(id: string): Promise<CmaEnvironmentRecord | null>;
  getSession(id: string): Promise<CmaSessionRecord | null>;
  listAgents(): Promise<readonly CmaAgentRecord[]>;
  listEnvironments(): Promise<readonly CmaEnvironmentRecord[]>;
  listSessionEvents(sessionId: string): Promise<readonly CmaSessionEventRecord[]>;
  watchSessionEvents(sessionId: string): AsyncIterable<CmaSessionEventRecord>;
}
