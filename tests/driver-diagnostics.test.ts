import { describe, expect, test } from "bun:test";

import {
  createDriverDiagnosticEvent,
  pushDriverDiagnosticEvent,
} from "../src/core/driver-diagnostics";

describe("driver diagnostics", () => {
  test("creates typed diagnostic runtime events", () => {
    expect(
      createDriverDiagnosticEvent({
        code: "driver.mcp_execute_failed",
        details: {
          commandId: "mcp-1",
        },
        message: "MCP execute failed.",
        reason: "upstream_error",
        severity: "error",
        source: "core",
      }),
    ).toEqual({
      kind: "diagnostic.reported",
      payload: {
        code: "driver.mcp_execute_failed",
        details: {
          commandId: "mcp-1",
        },
        message: "MCP execute failed.",
        reason: "upstream_error",
        severity: "error",
        source: "core",
      },
      visibility: "owner_debug",
    });
  });

  test("pushes diagnostics without failing the caller when the port rejects", async () => {
    await expect(
      pushDriverDiagnosticEvent(
        {
          pushEvents: async () => {
            throw new Error("transport closed");
          },
        },
        {
          code: "driver.transport_disconnected",
          message: "Transport disconnected.",
          severity: "warn",
          source: "transport",
        },
      ),
    ).resolves.toBeUndefined();
  });
});
