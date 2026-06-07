import { describe, expect, test } from "bun:test";

import type { RuntimeCommand } from "../src/runtime-command";
import { createCmaMemoryStore } from "../src/stores/memory";
import type { CmaHttpDriverCommandDispatchInput } from "../src/surfaces/cma-http";
import {
  CMA_DEFAULT_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  createCmaHttpHandler,
} from "../src/surfaces/cma-http";

function cmaRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set(CMA_DEFAULT_BETA_HEADER_NAME, CMA_DEFAULT_BETA_HEADER_VALUE);

  return new Request(`https://driver.test${path}`, {
    ...init,
    headers,
  });
}

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`https://driver.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      [CMA_DEFAULT_BETA_HEADER_NAME]: CMA_DEFAULT_BETA_HEADER_VALUE,
      "content-type": "application/json",
    },
    method,
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function readSseChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("Expected SSE response body.");
  }

  const chunk = await reader.read();
  await reader.cancel();

  if (chunk.done) {
    throw new Error("Expected SSE response chunk.");
  }

  return new TextDecoder().decode(chunk.value);
}

describe("CMA HTTP surface", () => {
  test("requires the Managed Agents beta header by default", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const response = await handler(new Request("https://driver.test/v1/environments"));

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "CMA_BETA_HEADER_REQUIRED",
        header: CMA_DEFAULT_BETA_HEADER_NAME,
      },
    });
  });

  test("runs configurable authorization before routing", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      authorize: ({ request }) =>
        request.headers.get("authorization") === "Bearer token"
          ? undefined
          : new Response(
              JSON.stringify({
                error: {
                  code: "UNAUTHORIZED",
                },
              }),
              { status: 401 },
            ),
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const rejected = await handler(cmaRequest("/v1/environments"));
    expect(rejected.status).toBe(401);

    const accepted = await handler(
      cmaRequest("/v1/environments", {
        headers: {
          authorization: "Bearer token",
        },
      }),
    );
    expect(accepted.status).toBe(200);
  });

  test("creates, lists, retrieves, archives, and deletes environments", async () => {
    const store = createCmaMemoryStore({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const created = await handler(
      jsonRequest("/v1/environments", "POST", {
        config: {
          networking: {
            allow_mcp_servers: true,
            allow_package_managers: true,
            allowed_hosts: ["https://api.example.com"],
            type: "limited",
          },
          packages: {
            npm: ["express@4.18.0"],
            pip: ["pandas==2.2.0"],
          },
          type: "cloud",
        },
        id: "environment-1",
        metadata: {
          tier: "dev",
        },
        name: "Main",
      }),
    );
    expect(created.status).toBe(201);
    expect(await readJson(created)).toMatchObject({
      data: {
        archivedAt: null,
        config: {
          networking: {
            allow_mcp_servers: true,
            allow_package_managers: true,
            allowed_hosts: ["https://api.example.com"],
            type: "limited",
          },
          packages: {
            npm: ["express@4.18.0"],
            pip: ["pandas==2.2.0"],
          },
          type: "cloud",
        },
        id: "environment-1",
        metadata: {
          tier: "dev",
        },
        name: "Main",
      },
    });

    const listed = await handler(cmaRequest("/v1/environments"));
    expect(await readJson(listed)).toMatchObject({
      data: [
        {
          id: "environment-1",
        },
      ],
    });

    const archived = await handler(
      cmaRequest("/v1/environments/environment-1/archive", {
        method: "POST",
      }),
    );
    expect(await readJson(archived)).toMatchObject({
      data: {
        archivedAt: "2026-01-01T00:00:00.000Z",
        id: "environment-1",
      },
    });

    const deleted = await handler(
      cmaRequest("/v1/environments/environment-1", {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(204);

    const missing = await handler(cmaRequest("/v1/environments/environment-1"));
    expect(missing.status).toBe(404);
  });

  test("defaults environment config to cloud unrestricted networking", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const created = await handler(
      jsonRequest("/v1/environments", "POST", {
        id: "environment-1",
        name: "Main",
      }),
    );

    expect(created.status).toBe(201);
    expect(await readJson(created)).toMatchObject({
      data: {
        config: {
          networking: {
            type: "unrestricted",
          },
          packages: {},
          type: "cloud",
        },
      },
    });
  });

  test("reports unsupported environment config as capability gaps", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const response = await handler(
      jsonRequest("/v1/environments", "POST", {
        config: {
          type: "self_hosted",
        },
        id: "environment-1",
        name: "Main",
      }),
    );

    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "CMA_CAPABILITY_GAP",
        feature: "environment.config.self_hosted",
      },
    });
  });

  test("rejects unsupported environment config fields and invalid allowed hosts", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });

    const unsupported = await handler(
      jsonRequest("/v1/environments", "POST", {
        config: {
          runtime: "test",
          type: "cloud",
        },
        id: "environment-1",
        name: "Main",
      }),
    );
    expect(unsupported.status).toBe(400);
    expect(await readJson(unsupported)).toMatchObject({
      error: {
        code: "CMA_UNSUPPORTED_FIELD",
        field: "config.runtime",
      },
    });

    const invalidHost = await handler(
      jsonRequest("/v1/environments", "POST", {
        config: {
          networking: {
            allowed_hosts: ["api.example.com"],
            type: "limited",
          },
          type: "cloud",
        },
        id: "environment-2",
        name: "Main",
      }),
    );
    expect(invalidHost.status).toBe(400);
    expect(await readJson(invalidHost)).toMatchObject({
      error: {
        code: "CMA_INVALID_FIELD",
      },
    });
  });

  test("creates sessions and dispatches inbound user events as runtime commands", async () => {
    const dispatched: CmaHttpDriverCommandDispatchInput[] = [];
    const store = createCmaMemoryStore({
      agents: [
        {
          id: "agent-1",
          name: "Support",
        },
      ],
      environments: [
        {
          id: "environment-1",
          name: "Main",
        },
      ],
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async (input) => {
        dispatched.push(input);
        return {
          requestId: "request-1",
        };
      },
      store,
    });

    const session = await handler(
      jsonRequest("/v1/sessions", "POST", {
        agentId: "agent-1",
        environmentId: "environment-1",
        id: "session-1",
      }),
    );
    expect(session.status).toBe(201);

    const accepted = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        commandId: "command-1",
        requestId: "request-1",
        runId: "run-1",
        text: "hello",
        type: "user.message",
      }),
    );
    expect(accepted.status).toBe(202);

    const command = dispatched[0]?.command;
    expect(command).toEqual({
      commandId: "command-1",
      input: {
        text: "hello",
      },
      kind: "input.start",
      requestId: "request-1",
      runId: "run-1",
    } satisfies RuntimeCommand);
    expect(await readJson(accepted)).toMatchObject({
      data: {
        command: {
          kind: "input.start",
        },
        event: {
          direction: "inbound",
          sessionId: "session-1",
        },
        result: {
          requestId: "request-1",
        },
        status: "accepted",
      },
    });
  });

  test("replays stored session events as JSON and server-sent events", async () => {
    const store = createCmaMemoryStore({
      sessions: [
        {
          id: "session-1",
        },
      ],
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    await store.appendDriverEvent("session-1", {
      kind: "message.delta",
      payload: {
        contentDelta: "hello",
        messageId: "message-1",
      },
    });

    const jsonReplay = await handler(cmaRequest("/v1/sessions/session-1/events"));
    expect(await readJson(jsonReplay)).toMatchObject({
      data: [
        {
          direction: "outbound",
          event: {
            sourceEventKind: "message.delta",
            type: "agent.message",
          },
          sessionId: "session-1",
        },
      ],
    });

    const sseReplay = await handler(
      cmaRequest("/v1/sessions/session-1/events", {
        headers: {
          accept: "text/event-stream",
        },
      }),
    );
    expect(sseReplay.headers.get("content-type")).toContain("text/event-stream");
    const body = await readSseChunk(sseReplay);
    expect(body).toContain("event: agent.message");
    expect(body).toContain('"sourceEventKind":"message.delta"');
  });

  test("streams live session events after replay", async () => {
    const store = createCmaMemoryStore({
      sessions: [
        {
          id: "session-1",
        },
      ],
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const response = await handler(
      cmaRequest("/v1/sessions/session-1/events", {
        headers: {
          accept: "text/event-stream",
        },
      }),
    );
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("Expected SSE response body.");
    }

    await store.appendDriverEvent("session-1", {
      kind: "message.delta",
      payload: {
        contentDelta: "live",
        messageId: "message-1",
      },
    });

    const chunk = await reader.read();
    await reader.cancel();

    if (chunk.done) {
      throw new Error("Expected live SSE response chunk.");
    }

    const body = new TextDecoder().decode(chunk.value);
    expect(body).toContain("event: agent.message");
    expect(body).toContain('"contentDelta":"live"');
  });

  test("rejects unsupported inbound event fields before dispatch", async () => {
    const dispatched: CmaHttpDriverCommandDispatchInput[] = [];
    const store = createCmaMemoryStore({
      sessions: [
        {
          id: "session-1",
        },
      ],
    });
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async (input) => {
        dispatched.push(input);
      },
      store,
    });

    const response = await handler(
      jsonRequest("/v1/sessions/session-1/events", "POST", {
        commandId: "command-1",
        metadata: {
          unsupported: true,
        },
        requestId: "request-1",
        runId: "run-1",
        text: "hello",
        type: "user.message",
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: {
        code: "CMA_UNSUPPORTED_FIELD",
        field: "metadata",
      },
    });
    expect(dispatched).toHaveLength(0);
  });
});
