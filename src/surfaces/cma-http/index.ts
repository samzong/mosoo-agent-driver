import { CmaUnsupportedFieldError, parseCmaInboundEvent } from "../../projections/cma";
import type { CmaInboundEvent } from "../../projections/cma";
import { projectCmaInboundToDriverCommand } from "../../projections/cma";
import type { RuntimeCommand, RuntimeCommandResult } from "../../runtime-command";
import type {
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentConfig,
  CmaEnvironmentLimitedNetworking,
  CmaEnvironmentNetworking,
  CmaEnvironmentPackages,
  CmaEnvironmentPackageManager,
  CmaSessionEventRecord,
  CmaSessionRecord,
  CmaStore,
} from "../../stores/cma-store";
import { CmaStoreConflictError, CmaStoreNotFoundError } from "../../stores/cma-store";

type HttpMethod = "DELETE" | "GET" | "POST";

export const CMA_DEFAULT_BETA_HEADER_NAME = "anthropic-beta";
export const CMA_DEFAULT_BETA_HEADER_VALUE = "managed-agents-2026-04-01";

export interface CmaHttpAuthorizationContext {
  readonly request: Request;
  readonly segments: readonly string[];
}

export type CmaHttpAuthorizer = (
  context: CmaHttpAuthorizationContext,
) => Promise<Response | void> | Response | void;

export interface CmaHttpBetaHeaderRequirement {
  readonly name?: string;
  readonly value?: string;
}

export interface CmaHttpDriverCommandDispatchInput {
  readonly command: RuntimeCommand;
  readonly event: CmaInboundEvent;
  readonly session: CmaSessionRecord;
}

export type CmaHttpDriverCommandDispatcher = (
  input: CmaHttpDriverCommandDispatchInput,
) => Promise<RuntimeCommandResult | void>;

export interface CmaHttpHandlerOptions {
  readonly authorize?: CmaHttpAuthorizer;
  readonly betaHeader?: CmaHttpBetaHeaderRequirement | false;
  readonly dispatchDriverCommand: CmaHttpDriverCommandDispatcher;
  readonly store: CmaStore;
}

export type CmaHttpHandler = (request: Request) => Promise<Response>;

class CmaHttpRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CmaHttpRequestError";
    this.status = status;
    this.code = code;
  }
}

class CmaHttpDriverDispatchError extends Error {
  readonly source: unknown;

  constructor(source: unknown) {
    super("Driver command dispatch failed.");
    this.name = "CmaHttpDriverDispatchError";
    this.source = source;
  }
}

class CmaHttpCapabilityGapError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`CMA capability is not supported in v0: ${feature}.`);
    this.name = "CmaHttpCapabilityGapError";
    this.feature = feature;
  }
}

const createAgentFields = new Set(["id", "metadata", "name"]);
const createEnvironmentFields = new Set(["config", "id", "metadata", "name"]);
const environmentConfigFields = new Set(["networking", "packages", "type"]);
const environmentLimitedNetworkingFields = new Set([
  "allow_mcp_servers",
  "allow_package_managers",
  "allowed_hosts",
  "type",
]);
const environmentPackageManagers = new Set<CmaEnvironmentPackageManager>([
  "apt",
  "cargo",
  "gem",
  "go",
  "npm",
  "pip",
]);
const environmentUnrestrictedNetworkingFields = new Set(["type"]);
const createSessionFields = new Set(["agentId", "environmentId", "id", "metadata"]);

function createJsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    status,
  });
}

function createDataResponse(data: unknown, status = 200): Response {
  return createJsonResponse({ data }, status);
}

function createErrorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return createJsonResponse(
    {
      error: {
        code,
        message,
        ...details,
      },
    },
    status,
  );
}

function createMethodNotAllowedResponse(methods: readonly HttpMethod[]): Response {
  return createErrorResponse(405, "CMA_METHOD_NOT_ALLOWED", "Method is not allowed.", {
    allow: methods,
  });
}

function createNotFoundResponse(): Response {
  return createErrorResponse(404, "CMA_ROUTE_NOT_FOUND", "Route was not found.");
}

function createBetaHeaderResponse(
  request: Request,
  requirement: CmaHttpBetaHeaderRequirement | false | undefined,
): Response | null {
  if (requirement === false) {
    return null;
  }

  const name = requirement?.name ?? CMA_DEFAULT_BETA_HEADER_NAME;
  const expectedValue = requirement?.value ?? CMA_DEFAULT_BETA_HEADER_VALUE;
  const actualValue = request.headers.get(name);

  if (!actualValue) {
    return createErrorResponse(
      400,
      "CMA_BETA_HEADER_REQUIRED",
      `CMA requires the ${name} header.`,
      {
        header: name,
      },
    );
  }

  const values = actualValue.split(",").map((value) => value.trim());

  if (!values.includes(expectedValue)) {
    return createErrorResponse(
      400,
      "CMA_UNSUPPORTED_BETA_HEADER",
      `CMA requires beta header ${expectedValue}.`,
      {
        expected: expectedValue,
        header: name,
      },
    );
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new CmaHttpRequestError(400, "CMA_INVALID_REQUEST", "Request body must be an object.");
  }

  return input;
}

function assertSupportedFields(
  input: Record<string, unknown>,
  supportedFields: ReadonlySet<string>,
  prefix = "",
): void {
  for (const field of Object.keys(input)) {
    if (!supportedFields.has(field)) {
      throw new CmaUnsupportedFieldError(`${prefix}${field}`);
    }
  }
}

function readString(input: Record<string, unknown>, field: string): string {
  const value = input[field];

  if (typeof value !== "string" || value.length === 0) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function readBoolean(input: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = input[field];

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be a boolean.`,
    );
  }

  return value;
}

function readOptionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function readOptionalStringArray(
  input: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be a non-empty string array.`,
    );
  }

  return [...value];
}

function readOptionalRecord(
  input: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = input[field];

  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be an object.`,
    );
  }

  return { ...value };
}

function readRequiredRecord(
  input: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = input[field];

  if (!isRecord(value)) {
    throw new CmaHttpRequestError(
      400,
      "CMA_INVALID_FIELD",
      `CMA field ${field} must be an object.`,
    );
  }

  return value;
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new CmaHttpRequestError(400, "CMA_INVALID_JSON", "Request body must be valid JSON.");
  }
}

function assertHttpsHosts(hosts: readonly string[], field: string): void {
  for (const host of hosts) {
    if (!host.startsWith("https://")) {
      throw new CmaHttpRequestError(
        400,
        "CMA_INVALID_FIELD",
        `CMA field ${field} entries must start with https://.`,
      );
    }
  }
}

function readEnvironmentPackages(input: Record<string, unknown>): CmaEnvironmentPackages {
  assertSupportedFields(input, environmentPackageManagers, "config.packages.");
  const packages: Partial<Record<CmaEnvironmentPackageManager, readonly string[]>> = {};

  for (const manager of environmentPackageManagers) {
    const value = readOptionalStringArray(input, manager);

    if (value !== undefined) {
      packages[manager] = value;
    }
  }

  return packages;
}

function readEnvironmentNetworking(input: unknown): CmaEnvironmentNetworking {
  if (input === undefined) {
    return {
      type: "unrestricted",
    };
  }

  const networking = assertObject(input);
  const type = readString(networking, "type");

  if (type === "unrestricted") {
    assertSupportedFields(
      networking,
      environmentUnrestrictedNetworkingFields,
      "config.networking.",
    );

    return {
      type,
    };
  }

  if (type === "limited") {
    assertSupportedFields(networking, environmentLimitedNetworkingFields, "config.networking.");
    const allowedHosts = readOptionalStringArray(networking, "allowed_hosts") ?? [];
    assertHttpsHosts(allowedHosts, "config.networking.allowed_hosts");

    return {
      allow_mcp_servers: readBoolean(networking, "allow_mcp_servers", false),
      allow_package_managers: readBoolean(networking, "allow_package_managers", false),
      allowed_hosts: allowedHosts,
      type,
    } satisfies CmaEnvironmentLimitedNetworking;
  }

  throw new CmaHttpCapabilityGapError(`environment.networking.${type}`);
}

function readEnvironmentConfig(input: unknown): CmaEnvironmentConfig {
  if (input === undefined) {
    return {
      networking: {
        type: "unrestricted",
      },
      packages: {},
      type: "cloud",
    };
  }

  const config = assertObject(input);
  assertSupportedFields(config, environmentConfigFields, "config.");
  const type = readString(config, "type");

  if (type !== "cloud") {
    throw new CmaHttpCapabilityGapError(`environment.config.${type}`);
  }

  const packages =
    config["packages"] === undefined
      ? {}
      : readEnvironmentPackages(readRequiredRecord(config, "packages"));

  return {
    networking: readEnvironmentNetworking(config["networking"]),
    packages,
    type,
  };
}

function readCreateAgentInput(input: unknown): CmaCreateAgentInput {
  const body = assertObject(input);
  assertSupportedFields(body, createAgentFields);
  const id = readOptionalString(body, "id");
  const metadata = readOptionalRecord(body, "metadata");

  return {
    ...(id === undefined ? {} : { id }),
    ...(metadata === undefined ? {} : { metadata }),
    name: readString(body, "name"),
  };
}

function readCreateEnvironmentInput(input: unknown): CmaCreateEnvironmentInput {
  const body = assertObject(input);
  assertSupportedFields(body, createEnvironmentFields);
  const id = readOptionalString(body, "id");
  const metadata = readOptionalRecord(body, "metadata");

  return {
    config: readEnvironmentConfig(body["config"]),
    ...(id === undefined ? {} : { id }),
    ...(metadata === undefined ? {} : { metadata }),
    name: readString(body, "name"),
  };
}

function readCreateSessionInput(input: unknown): CmaCreateSessionInput {
  const body = assertObject(input);
  assertSupportedFields(body, createSessionFields);
  const agentId = readOptionalString(body, "agentId");
  const environmentId = readOptionalString(body, "environmentId");
  const id = readOptionalString(body, "id");
  const metadata = readOptionalRecord(body, "metadata");

  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(id === undefined ? {} : { id }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function readPathSegments(request: Request): readonly string[] {
  const url = new URL(request.url);
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

async function handleAgents(
  request: Request,
  segments: readonly string[],
  store: CmaStore,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method === "GET") {
      return createDataResponse(await store.listAgents());
    }

    if (request.method === "POST") {
      return createDataResponse(
        await store.createAgent(readCreateAgentInput(await readJsonBody(request))),
        201,
      );
    }

    return createMethodNotAllowedResponse(["GET", "POST"]);
  }

  if (segments.length === 3) {
    const agentId = segments[2];

    if (agentId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      const agent = await store.getAgent(agentId);
      return agent
        ? createDataResponse(agent)
        : createErrorResponse(404, "CMA_AGENT_NOT_FOUND", "Agent was not found.");
    }

    return createMethodNotAllowedResponse(["GET"]);
  }

  return createNotFoundResponse();
}

async function handleEnvironments(
  request: Request,
  segments: readonly string[],
  store: CmaStore,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method === "GET") {
      return createDataResponse(await store.listEnvironments());
    }

    if (request.method === "POST") {
      return createDataResponse(
        await store.createEnvironment(readCreateEnvironmentInput(await readJsonBody(request))),
        201,
      );
    }

    return createMethodNotAllowedResponse(["GET", "POST"]);
  }

  if (segments.length === 3) {
    const environmentId = segments[2];

    if (environmentId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      const environment = await store.getEnvironment(environmentId);
      return environment
        ? createDataResponse(environment)
        : createErrorResponse(404, "CMA_ENVIRONMENT_NOT_FOUND", "Environment was not found.");
    }

    if (request.method === "DELETE") {
      const deleted = await store.deleteEnvironment(environmentId);
      return deleted
        ? new Response(null, { status: 204 })
        : createErrorResponse(404, "CMA_ENVIRONMENT_NOT_FOUND", "Environment was not found.");
    }

    return createMethodNotAllowedResponse(["DELETE", "GET"]);
  }

  if (segments.length === 4 && segments[3] === "archive") {
    const environmentId = segments[2];

    if (environmentId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "POST") {
      return createDataResponse(await store.archiveEnvironment(environmentId));
    }

    return createMethodNotAllowedResponse(["POST"]);
  }

  return createNotFoundResponse();
}

async function handleGetSessionEvents(
  request: Request,
  sessionId: string,
  store: CmaStore,
): Promise<Response> {
  const session = await store.getSession(sessionId);

  if (!session) {
    return createErrorResponse(404, "CMA_SESSION_NOT_FOUND", "Session was not found.");
  }

  const events = await store.listSessionEvents(sessionId);

  if (request.headers.get("accept")?.includes("text/event-stream") === true) {
    return createSseResponse(events, store.watchSessionEvents(sessionId));
  }

  return createDataResponse(events);
}

async function handlePostSessionEvent(
  request: Request,
  sessionId: string,
  store: CmaStore,
  dispatchDriverCommand: CmaHttpDriverCommandDispatcher,
): Promise<Response> {
  const session = await store.getSession(sessionId);

  if (!session) {
    return createErrorResponse(404, "CMA_SESSION_NOT_FOUND", "Session was not found.");
  }

  const body = await readJsonBody(request);
  const event = parseCmaInboundEvent(body);
  const command = projectCmaInboundToDriverCommand(event);
  let commandResult: RuntimeCommandResult | null = null;

  try {
    commandResult = (await dispatchDriverCommand({ command, event, session })) ?? null;
  } catch (error) {
    throw new CmaHttpDriverDispatchError(error);
  }

  const record = await store.appendInboundEvent({
    command,
    commandResult,
    event,
    sessionId,
  });

  return createDataResponse(
    {
      command,
      event: record,
      result: commandResult,
      status: "accepted",
    },
    202,
  );
}

async function handleSessions(
  request: Request,
  segments: readonly string[],
  options: CmaHttpHandlerOptions,
): Promise<Response> {
  if (segments.length === 2) {
    if (request.method === "POST") {
      return createDataResponse(
        await options.store.createSession(readCreateSessionInput(await readJsonBody(request))),
        201,
      );
    }

    return createMethodNotAllowedResponse(["POST"]);
  }

  if (segments.length === 3) {
    const sessionId = segments[2];

    if (sessionId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      const session = await options.store.getSession(sessionId);
      return session
        ? createDataResponse(session)
        : createErrorResponse(404, "CMA_SESSION_NOT_FOUND", "Session was not found.");
    }

    return createMethodNotAllowedResponse(["GET"]);
  }

  if (segments.length === 4 && segments[3] === "events") {
    const sessionId = segments[2];

    if (sessionId === undefined) {
      return createNotFoundResponse();
    }

    if (request.method === "GET") {
      return handleGetSessionEvents(request, sessionId, options.store);
    }

    if (request.method === "POST") {
      return handlePostSessionEvent(
        request,
        sessionId,
        options.store,
        options.dispatchDriverCommand,
      );
    }

    return createMethodNotAllowedResponse(["GET", "POST"]);
  }

  return createNotFoundResponse();
}

function formatSseRecord(record: CmaSessionEventRecord): string {
  return `id: ${record.id}\nevent: ${record.event.type}\ndata: ${JSON.stringify(record)}\n\n`;
}

function createSseResponse(
  replayEvents: readonly CmaSessionEventRecord[],
  liveEvents: AsyncIterable<CmaSessionEventRecord>,
): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  let iterator: AsyncIterator<CmaSessionEventRecord> | null = null;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const record of replayEvents) {
          controller.enqueue(encoder.encode(formatSseRecord(record)));
        }

        iterator = liveEvents[Symbol.asyncIterator]();

        for (;;) {
          if (cancelled) {
            break;
          }

          const result = await iterator.next();

          if (result.done) {
            break;
          }

          controller.enqueue(encoder.encode(formatSseRecord(result.value)));
        }

        if (!cancelled) {
          controller.close();
        }
      } catch (error) {
        if (!cancelled) {
          controller.error(error);
        }
      }
    },
    cancel() {
      cancelled = true;
      void iterator?.return?.();
    },
  });

  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
    status: 200,
  });
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function createThrownErrorResponse(error: unknown): Response {
  if (error instanceof CmaUnsupportedFieldError) {
    return createErrorResponse(400, "CMA_UNSUPPORTED_FIELD", error.message, {
      field: error.field,
    });
  }

  if (error instanceof CmaHttpRequestError) {
    return createErrorResponse(error.status, error.code, error.message);
  }

  if (error instanceof CmaStoreConflictError) {
    return createErrorResponse(409, "CMA_RESOURCE_CONFLICT", error.message, {
      id: error.id,
      resource: error.resource,
    });
  }

  if (error instanceof CmaStoreNotFoundError) {
    return createErrorResponse(404, "CMA_RESOURCE_NOT_FOUND", error.message, {
      id: error.id,
      resource: error.resource,
    });
  }

  if (error instanceof CmaHttpDriverDispatchError) {
    return createErrorResponse(
      502,
      "CMA_DRIVER_COMMAND_DISPATCH_FAILED",
      messageFromUnknown(error.source),
    );
  }

  if (error instanceof CmaHttpCapabilityGapError) {
    return createErrorResponse(422, "CMA_CAPABILITY_GAP", error.message, {
      feature: error.feature,
    });
  }

  return createErrorResponse(500, "CMA_INTERNAL_ERROR", messageFromUnknown(error));
}

export function createCmaHttpHandler(options: CmaHttpHandlerOptions): CmaHttpHandler {
  return async (request) => {
    try {
      const segments = readPathSegments(request);

      if (segments[0] !== "v1") {
        return createNotFoundResponse();
      }

      const betaHeaderResponse = createBetaHeaderResponse(request, options.betaHeader);

      if (betaHeaderResponse) {
        return betaHeaderResponse;
      }

      const authorizationResponse = await options.authorize?.({ request, segments });

      if (authorizationResponse) {
        return authorizationResponse;
      }

      switch (segments[1]) {
        case "agents":
          return await handleAgents(request, segments, options.store);
        case "environments":
          return await handleEnvironments(request, segments, options.store);
        case "sessions":
          return await handleSessions(request, segments, options);
        default:
          return createNotFoundResponse();
      }
    } catch (error) {
      return createThrownErrorResponse(error);
    }
  };
}
