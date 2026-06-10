import { describe, expect, test } from "bun:test";

import { createOpenAiTurnStartParams } from "../src/runtimes/openai/app-server-driver-backend";

describe("OpenAI app-server turn start params", () => {
  test("carries runtime policy with every user turn", () => {
    expect(
      createOpenAiTurnStartParams({
        cwd: "/workspace",
        model: "gpt-5.4",
        text: "Run pwd",
        threadId: "thread-1",
      }),
    ).toEqual({
      approvalPolicy: "on-request",
      cwd: "/workspace",
      input: [
        {
          text: "Run pwd",
          text_elements: [],
          type: "text",
        },
      ],
      model: "gpt-5.4",
      threadId: "thread-1",
    });
  });
});
