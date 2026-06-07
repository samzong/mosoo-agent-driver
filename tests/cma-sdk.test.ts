import { describe, expect, test } from "bun:test";

import { createCmaMemoryStore } from "../src/stores/memory";
import {
  CMA_DEFAULT_BETA_HEADER_NAME,
  CMA_DEFAULT_BETA_HEADER_VALUE,
  createCmaHttpHandler,
} from "../src/surfaces/cma-http";
import type { CmaSdkError } from "../src/surfaces/cma-sdk";
import { createCmaSdkClient } from "../src/surfaces/cma-sdk";

describe("CMA SDK client", () => {
  test("sends the default beta header and decodes JSON data responses", async () => {
    const seenBetaHeaders: string[] = [];
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seenBetaHeaders.push(request.headers.get(CMA_DEFAULT_BETA_HEADER_NAME) ?? "");
        return handler(request);
      },
    });

    const environment = await client.createEnvironment({
      id: "environment-1",
      name: "Main",
    });

    expect(environment).toMatchObject({
      id: "environment-1",
      name: "Main",
    });
    expect(seenBetaHeaders).toEqual([CMA_DEFAULT_BETA_HEADER_VALUE]);
  });

  test("throws typed errors for failed requests", async () => {
    const store = createCmaMemoryStore();
    const handler = createCmaHttpHandler({
      dispatchDriverCommand: async () => undefined,
      store,
    });
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (input, init) => handler(new Request(input, init)),
    });

    await expect(client.getEnvironment("missing")).rejects.toMatchObject({
      code: "CMA_ENVIRONMENT_NOT_FOUND",
      status: 404,
    } satisfies Partial<CmaSdkError>);
  });

  test("streams server-sent session event replay through fetch", async () => {
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
    const client = createCmaSdkClient({
      baseUrl: "https://driver.test",
      fetch: async (input, init) => handler(new Request(input, init)),
    });
    await store.appendDriverEvent("session-1", {
      kind: "message.delta",
      payload: {
        contentDelta: "hello",
        messageId: "message-1",
      },
    });

    const events = [];

    for await (const event of client.streamSessionEvents("session-1")) {
      events.push(event);
      break;
    }

    expect(events).toMatchObject([
      {
        direction: "outbound",
        event: {
          sourceEventKind: "message.delta",
          type: "agent.message",
        },
      },
    ]);
  });
});
