import { projectDriverEventToCma } from "../../projections/cma";
import type { DriverEventInput } from "../../protocol/events";
import type {
  CmaAgentRecord,
  CmaAppendInboundEventInput,
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentConfig,
  CmaEnvironmentRecord,
  CmaSessionEventRecord,
  CmaSessionRecord,
  CmaStore,
} from "../cma-store";
import { CmaStoreConflictError, CmaStoreNotFoundError } from "../cma-store";

export type CmaMemoryStoreIdFactory = (
  resource: "agent" | "environment" | "event" | "session",
) => string;

export interface CmaMemoryStoreOptions {
  readonly agents?: readonly CmaCreateAgentInput[];
  readonly environments?: readonly CmaCreateEnvironmentInput[];
  readonly idFactory?: CmaMemoryStoreIdFactory;
  readonly now?: () => Date;
  readonly sessions?: readonly CmaCreateSessionInput[];
}

function createDefaultId(resource: "agent" | "environment" | "event" | "session"): string {
  return `${resource}-${globalThis.crypto.randomUUID()}`;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function sortById<T extends { readonly id: string }>(records: Iterable<T>): T[] {
  return [...records].toSorted((left, right) => left.id.localeCompare(right.id));
}

function cloneAgent(record: CmaAgentRecord): CmaAgentRecord {
  return {
    ...record,
    metadata: cloneRecord(record.metadata),
  };
}

function cloneEnvironmentConfig(config: CmaEnvironmentConfig): CmaEnvironmentConfig {
  return {
    networking:
      config.networking.type === "limited"
        ? {
            allow_mcp_servers: config.networking.allow_mcp_servers,
            allow_package_managers: config.networking.allow_package_managers,
            allowed_hosts: [...config.networking.allowed_hosts],
            type: "limited",
          }
        : {
            type: "unrestricted",
          },
    packages: Object.fromEntries(
      Object.entries(config.packages).map(([manager, packages]) => [manager, [...packages]]),
    ),
    type: "cloud",
  };
}

function cloneEnvironment(record: CmaEnvironmentRecord): CmaEnvironmentRecord {
  return {
    ...record,
    config: cloneEnvironmentConfig(record.config),
    metadata: cloneRecord(record.metadata),
  };
}

function cloneSession(record: CmaSessionRecord): CmaSessionRecord {
  return {
    ...record,
    metadata: cloneRecord(record.metadata),
  };
}

function cloneEvent(record: CmaSessionEventRecord): CmaSessionEventRecord {
  return { ...record };
}

function createDefaultEnvironmentConfig(): CmaEnvironmentConfig {
  return {
    networking: {
      type: "unrestricted",
    },
    packages: {},
    type: "cloud",
  };
}

class CmaMemoryEventSubscriber {
  readonly #values: CmaSessionEventRecord[] = [];
  readonly #waiters: ((result: IteratorResult<CmaSessionEventRecord>) => void)[] = [];
  #closed = false;

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const waiter of this.#waiters.splice(0)) {
      waiter({
        done: true,
        value: undefined,
      });
    }
  }

  next(): Promise<IteratorResult<CmaSessionEventRecord>> {
    const value = this.#values.shift();

    if (value) {
      return Promise.resolve({
        done: false,
        value,
      });
    }

    if (this.#closed) {
      return Promise.resolve({
        done: true,
        value: undefined,
      });
    }

    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  push(record: CmaSessionEventRecord): void {
    if (this.#closed) {
      return;
    }

    const value = cloneEvent(record);
    const waiter = this.#waiters.shift();

    if (waiter) {
      waiter({
        done: false,
        value,
      });
      return;
    }

    this.#values.push(value);
  }

  async *values(): AsyncIterable<CmaSessionEventRecord> {
    while (true) {
      const result = await this.next();

      if (result.done) {
        return;
      }

      yield result.value;
    }
  }
}

export function createCmaMemoryStore(options: CmaMemoryStoreOptions = {}): CmaMemoryStore {
  return new CmaMemoryStore(options);
}

export class CmaMemoryStore implements CmaStore {
  readonly #agents = new Map<string, CmaAgentRecord>();
  readonly #environments = new Map<string, CmaEnvironmentRecord>();
  readonly #eventsBySessionId = new Map<string, CmaSessionEventRecord[]>();
  readonly #idFactory: CmaMemoryStoreIdFactory;
  readonly #now: () => Date;
  readonly #sessions = new Map<string, CmaSessionRecord>();
  readonly #subscribersBySessionId = new Map<string, Set<CmaMemoryEventSubscriber>>();

  constructor(options: CmaMemoryStoreOptions = {}) {
    this.#idFactory = options.idFactory ?? createDefaultId;
    this.#now = options.now ?? (() => new Date());

    for (const agent of options.agents ?? []) {
      this.#putAgent(agent);
    }

    for (const environment of options.environments ?? []) {
      this.#putEnvironment(environment);
    }

    for (const session of options.sessions ?? []) {
      this.#putSession(session);
    }
  }

  async appendDriverEvent(
    sessionId: string,
    driverEvent: DriverEventInput,
  ): Promise<readonly CmaSessionEventRecord[]> {
    this.#requireSession(sessionId);

    const events = projectDriverEventToCma(driverEvent).map((event) =>
      this.#appendEvent({
        command: null,
        commandResult: null,
        direction: "outbound",
        driverEvent,
        event,
        sessionId,
      }),
    );

    return events.map(cloneEvent);
  }

  async appendInboundEvent(input: CmaAppendInboundEventInput): Promise<CmaSessionEventRecord> {
    this.#requireSession(input.sessionId);

    return cloneEvent(
      this.#appendEvent({
        command: input.command,
        commandResult: input.commandResult,
        direction: "inbound",
        driverEvent: null,
        event: input.event,
        sessionId: input.sessionId,
      }),
    );
  }

  async archiveEnvironment(id: string): Promise<CmaEnvironmentRecord> {
    const environment = this.#requireEnvironment(id);
    const archivedAt = environment.archivedAt ?? this.#nowIso();
    const updated = {
      ...environment,
      archivedAt,
      updatedAt: this.#nowIso(),
    } satisfies CmaEnvironmentRecord;
    this.#environments.set(id, updated);
    return cloneEnvironment(updated);
  }

  async createAgent(input: CmaCreateAgentInput): Promise<CmaAgentRecord> {
    return cloneAgent(this.#putAgent(input));
  }

  async createEnvironment(input: CmaCreateEnvironmentInput): Promise<CmaEnvironmentRecord> {
    return cloneEnvironment(this.#putEnvironment(input));
  }

  async createSession(input: CmaCreateSessionInput): Promise<CmaSessionRecord> {
    return cloneSession(this.#putSession(input));
  }

  async deleteEnvironment(id: string): Promise<boolean> {
    return this.#environments.delete(id);
  }

  async getAgent(id: string): Promise<CmaAgentRecord | null> {
    const agent = this.#agents.get(id);
    return agent ? cloneAgent(agent) : null;
  }

  async getEnvironment(id: string): Promise<CmaEnvironmentRecord | null> {
    const environment = this.#environments.get(id);
    return environment ? cloneEnvironment(environment) : null;
  }

  async getSession(id: string): Promise<CmaSessionRecord | null> {
    const session = this.#sessions.get(id);
    return session ? cloneSession(session) : null;
  }

  async listAgents(): Promise<readonly CmaAgentRecord[]> {
    return sortById(this.#agents.values()).map(cloneAgent);
  }

  async listEnvironments(): Promise<readonly CmaEnvironmentRecord[]> {
    return sortById(this.#environments.values()).map(cloneEnvironment);
  }

  async listSessionEvents(sessionId: string): Promise<readonly CmaSessionEventRecord[]> {
    this.#requireSession(sessionId);
    return (this.#eventsBySessionId.get(sessionId) ?? []).map(cloneEvent);
  }

  watchSessionEvents(sessionId: string): AsyncIterable<CmaSessionEventRecord> {
    this.#requireSession(sessionId);
    const subscriber = new CmaMemoryEventSubscriber();
    const subscribers = this.#subscribersBySessionId.get(sessionId) ?? new Set();
    subscribers.add(subscriber);
    this.#subscribersBySessionId.set(sessionId, subscribers);
    return this.#createSubscription(sessionId, subscriber);
  }

  #appendEvent(input: Omit<CmaSessionEventRecord, "createdAt" | "id">): CmaSessionEventRecord {
    const record = {
      ...input,
      createdAt: this.#nowIso(),
      id: this.#idFactory("event"),
    } satisfies CmaSessionEventRecord;
    const events = this.#eventsBySessionId.get(input.sessionId) ?? [];
    events.push(record);
    this.#eventsBySessionId.set(input.sessionId, events);
    this.#publishEvent(record);
    return record;
  }

  async *#createSubscription(
    sessionId: string,
    subscriber: CmaMemoryEventSubscriber,
  ): AsyncIterable<CmaSessionEventRecord> {
    try {
      yield* subscriber.values();
    } finally {
      subscriber.close();
      const subscribers = this.#subscribersBySessionId.get(sessionId);
      subscribers?.delete(subscriber);

      if (subscribers?.size === 0) {
        this.#subscribersBySessionId.delete(sessionId);
      }
    }
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }

  #putAgent(input: CmaCreateAgentInput): CmaAgentRecord {
    const id = input.id ?? this.#idFactory("agent");

    if (this.#agents.has(id)) {
      throw new CmaStoreConflictError("agent", id);
    }

    const now = this.#nowIso();
    const record = {
      createdAt: now,
      id,
      metadata: cloneRecord(input.metadata ?? {}),
      name: input.name,
      updatedAt: now,
    } satisfies CmaAgentRecord;
    this.#agents.set(id, record);
    return record;
  }

  #putEnvironment(input: CmaCreateEnvironmentInput): CmaEnvironmentRecord {
    const id = input.id ?? this.#idFactory("environment");

    if (this.#environments.has(id)) {
      throw new CmaStoreConflictError("environment", id);
    }

    const now = this.#nowIso();
    const record = {
      archivedAt: null,
      config: cloneEnvironmentConfig(input.config ?? createDefaultEnvironmentConfig()),
      createdAt: now,
      id,
      metadata: cloneRecord(input.metadata ?? {}),
      name: input.name,
      updatedAt: now,
    } satisfies CmaEnvironmentRecord;
    this.#environments.set(id, record);
    return record;
  }

  #putSession(input: CmaCreateSessionInput): CmaSessionRecord {
    const id = input.id ?? this.#idFactory("session");

    if (this.#sessions.has(id)) {
      throw new CmaStoreConflictError("session", id);
    }

    if (input.agentId !== undefined && !this.#agents.has(input.agentId)) {
      throw new CmaStoreNotFoundError("agent", input.agentId);
    }

    if (input.environmentId !== undefined && !this.#environments.has(input.environmentId)) {
      throw new CmaStoreNotFoundError("environment", input.environmentId);
    }

    const now = this.#nowIso();
    const record = {
      agentId: input.agentId ?? null,
      createdAt: now,
      environmentId: input.environmentId ?? null,
      id,
      metadata: cloneRecord(input.metadata ?? {}),
      status: "idle",
      updatedAt: now,
    } satisfies CmaSessionRecord;
    this.#sessions.set(id, record);
    return record;
  }

  #publishEvent(record: CmaSessionEventRecord): void {
    for (const subscriber of this.#subscribersBySessionId.get(record.sessionId) ?? []) {
      subscriber.push(record);
    }
  }

  #requireEnvironment(id: string): CmaEnvironmentRecord {
    const environment = this.#environments.get(id);

    if (!environment) {
      throw new CmaStoreNotFoundError("environment", id);
    }

    return environment;
  }

  #requireSession(id: string): CmaSessionRecord {
    const session = this.#sessions.get(id);

    if (!session) {
      throw new CmaStoreNotFoundError("session", id);
    }

    return session;
  }
}
