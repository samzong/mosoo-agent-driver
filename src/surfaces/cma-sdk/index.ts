import type { CmaInboundEvent } from "../../projections/cma";
import type { RuntimeCommand, RuntimeCommandResult } from "../../runtime-command";
import type {
  CmaAgentRecord,
  CmaCreateAgentInput,
  CmaCreateEnvironmentInput,
  CmaCreateSessionInput,
  CmaEnvironmentRecord,
  CmaSessionEventRecord,
  CmaSessionRecord,
} from "../../stores/cma-store";
import { CMA_DEFAULT_BETA_HEADER_NAME, CMA_DEFAULT_BETA_HEADER_VALUE } from "../cma-http";

export type CmaSdkFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CmaSdkBetaHeader {
  readonly name?: string;
  readonly value?: string;
}

export interface CmaSdkClientOptions {
  readonly baseUrl: string | URL;
  readonly betaHeader?: CmaSdkBetaHeader | false;
  readonly fetch?: CmaSdkFetch;
  readonly headers?: HeadersInit;
}

export interface CmaSessionEventDispatchRecord {
  readonly command: RuntimeCommand;
  readonly event: CmaSessionEventRecord;
  readonly result: RuntimeCommandResult | null;
  readonly status: "accepted";
}

export interface CmaSdkClient {
  archiveEnvironment(id: string): Promise<CmaEnvironmentRecord>;
  createAgent(input: CmaCreateAgentInput): Promise<CmaAgentRecord>;
  createEnvironment(input: CmaCreateEnvironmentInput): Promise<CmaEnvironmentRecord>;
  createSession(input: CmaCreateSessionInput): Promise<CmaSessionRecord>;
  deleteEnvironment(id: string): Promise<void>;
  getAgent(id: string): Promise<CmaAgentRecord>;
  getEnvironment(id: string): Promise<CmaEnvironmentRecord>;
  getSession(id: string): Promise<CmaSessionRecord>;
  listAgents(): Promise<readonly CmaAgentRecord[]>;
  listEnvironments(): Promise<readonly CmaEnvironmentRecord[]>;
  listSessionEvents(sessionId: string): Promise<readonly CmaSessionEventRecord[]>;
  sendSessionEvent(
    sessionId: string,
    event: CmaInboundEvent,
  ): Promise<CmaSessionEventDispatchRecord>;
  streamSessionEvents(sessionId: string): AsyncIterable<CmaSessionEventRecord>;
}

export class CmaSdkError extends Error {
  readonly body: unknown;
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = "CmaSdkError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorCode(body: unknown): string {
  if (!isRecord(body)) {
    return "CMA_SDK_HTTP_ERROR";
  }

  const error = body["error"];

  if (!isRecord(error)) {
    return "CMA_SDK_HTTP_ERROR";
  }

  const code = error["code"];
  return typeof code === "string" && code.length > 0 ? code : "CMA_SDK_HTTP_ERROR";
}

function readErrorMessage(body: unknown, fallback: string): string {
  if (!isRecord(body)) {
    return fallback;
  }

  const error = body["error"];

  if (!isRecord(error)) {
    return fallback;
  }

  const message = error["message"];
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

function readData(body: unknown): unknown {
  if (!isRecord(body) || !("data" in body)) {
    throw new CmaSdkError(500, "CMA_SDK_INVALID_RESPONSE", "CMA response is missing data.", body);
  }

  return body["data"];
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function parseSseRecord(frame: string): CmaSessionEventRecord | null {
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return JSON.parse(dataLines.join("\n")) as CmaSessionEventRecord;
}

function extractSseRecords(buffer: string): {
  readonly records: readonly CmaSessionEventRecord[];
  readonly rest: string;
} {
  const records: CmaSessionEventRecord[] = [];
  let rest = buffer;
  let separatorIndex = rest.indexOf("\n\n");

  while (separatorIndex >= 0) {
    const frame = rest.slice(0, separatorIndex);
    const record = parseSseRecord(frame);

    if (record) {
      records.push(record);
    }

    rest = rest.slice(separatorIndex + 2);
    separatorIndex = rest.indexOf("\n\n");
  }

  return {
    records,
    rest,
  };
}

export function createCmaSdkClient(options: CmaSdkClientOptions): CmaSdkClient {
  return new CmaSdkClientCore(options);
}

class CmaSdkClientCore implements CmaSdkClient {
  readonly #baseUrl: URL;
  readonly #fetch: CmaSdkFetch;
  readonly #headers: Headers;

  constructor(options: CmaSdkClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#fetch = options.fetch ?? defaultFetch;
    this.#headers = new Headers(options.headers);

    if (options.betaHeader !== false) {
      this.#headers.set(
        options.betaHeader?.name ?? CMA_DEFAULT_BETA_HEADER_NAME,
        options.betaHeader?.value ?? CMA_DEFAULT_BETA_HEADER_VALUE,
      );
    }
  }

  async archiveEnvironment(id: string): Promise<CmaEnvironmentRecord> {
    return this.#requestData<CmaEnvironmentRecord>(
      `/v1/environments/${encodePathSegment(id)}/archive`,
      {
        method: "POST",
      },
    );
  }

  async createAgent(input: CmaCreateAgentInput): Promise<CmaAgentRecord> {
    return this.#requestData<CmaAgentRecord>("/v1/agents", {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async createEnvironment(input: CmaCreateEnvironmentInput): Promise<CmaEnvironmentRecord> {
    return this.#requestData<CmaEnvironmentRecord>("/v1/environments", {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async createSession(input: CmaCreateSessionInput): Promise<CmaSessionRecord> {
    return this.#requestData<CmaSessionRecord>("/v1/sessions", {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async deleteEnvironment(id: string): Promise<void> {
    await this.#request(`/v1/environments/${encodePathSegment(id)}`, {
      method: "DELETE",
    });
  }

  async getAgent(id: string): Promise<CmaAgentRecord> {
    return this.#requestData<CmaAgentRecord>(`/v1/agents/${encodePathSegment(id)}`);
  }

  async getEnvironment(id: string): Promise<CmaEnvironmentRecord> {
    return this.#requestData<CmaEnvironmentRecord>(`/v1/environments/${encodePathSegment(id)}`);
  }

  async getSession(id: string): Promise<CmaSessionRecord> {
    return this.#requestData<CmaSessionRecord>(`/v1/sessions/${encodePathSegment(id)}`);
  }

  async listAgents(): Promise<readonly CmaAgentRecord[]> {
    return this.#requestData<readonly CmaAgentRecord[]>("/v1/agents");
  }

  async listEnvironments(): Promise<readonly CmaEnvironmentRecord[]> {
    return this.#requestData<readonly CmaEnvironmentRecord[]>("/v1/environments");
  }

  async listSessionEvents(sessionId: string): Promise<readonly CmaSessionEventRecord[]> {
    return this.#requestData<readonly CmaSessionEventRecord[]>(
      `/v1/sessions/${encodePathSegment(sessionId)}/events`,
    );
  }

  async sendSessionEvent(
    sessionId: string,
    event: CmaInboundEvent,
  ): Promise<CmaSessionEventDispatchRecord> {
    return this.#requestData<CmaSessionEventDispatchRecord>(
      `/v1/sessions/${encodePathSegment(sessionId)}/events`,
      {
        body: JSON.stringify(event),
        method: "POST",
      },
    );
  }

  async *streamSessionEvents(sessionId: string): AsyncIterable<CmaSessionEventRecord> {
    const response = await this.#request(`/v1/sessions/${encodePathSegment(sessionId)}/events`, {
      headers: {
        accept: "text/event-stream",
      },
    });

    if (!response.body) {
      throw new CmaSdkError(
        500,
        "CMA_SDK_STREAM_UNAVAILABLE",
        "CMA event stream is unavailable.",
        null,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;

    try {
      while (true) {
        const chunk = await reader.read();

        if (chunk.done) {
          completed = true;
          break;
        }

        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = extractSseRecords(buffer);
        buffer = parsed.rest;

        for (const record of parsed.records) {
          yield record;
        }
      }

      buffer += decoder.decode();

      if (buffer.length > 0) {
        const parsed = extractSseRecords(`${buffer}\n\n`);

        for (const record of parsed.records) {
          yield record;
        }
      }
    } finally {
      if (!completed) {
        await reader.cancel();
      }
    }
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      ...init,
      headers: this.#createHeaders(init.headers),
    });

    if (response.ok) {
      return response;
    }

    const body = await this.#readResponseBody(response);
    throw new CmaSdkError(
      response.status,
      readErrorCode(body),
      readErrorMessage(body, `CMA request failed with status ${response.status}.`),
      body,
    );
  }

  async #requestData<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#request(path, {
      ...init,
      headers: this.#createHeaders(init.headers),
    });

    return readData(await this.#readResponseBody(response)) as T;
  }

  #createHeaders(input: HeadersInit | undefined): Headers {
    const headers = new Headers(this.#headers);

    if (input !== undefined) {
      for (const [name, value] of new Headers(input).entries()) {
        headers.set(name, value);
      }
    }

    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    return headers;
  }

  async #readResponseBody(response: Response): Promise<unknown> {
    if (response.status === 204) {
      return null;
    }

    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}
