import { describe, expect, test } from "bun:test";

import { DriverPermissionBroker } from "../src/core/driver-permission-broker";
import type { DriverRuntimeEventPort } from "../src/core/driver-runtime-io";
import type { DriverEventInput } from "../src/protocol/events";

interface RecordingSocket extends DriverRuntimeEventPort {
  readonly pushedEvents: DriverEventInput[];
}

function createRecordingSocket(): RecordingSocket {
  const pushedEvents: DriverEventInput[] = [];

  return {
    pushedEvents,
    pushEvents: async (input) => {
      pushedEvents.push(...input.events);
    },
  };
}

describe("DriverPermissionBroker", () => {
  test("emits canonical permission events and waits for the platform decision", async () => {
    const broker = new DriverPermissionBroker(() => null);
    const socket = createRecordingSocket();

    const request = broker.request(socket, {
      rawInput: '{"command":"fd ."}',
      requestId: "permission-1",
      title: "Approve command execution",
      toolCallId: "tool-1",
      toolKind: "bash",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.pushedEvents).toMatchObject([
      {
        kind: "permission.requested",
        payload: {
          details: '{"command":"fd ."}',
          requestId: "permission-1",
          targetItemId: "tool-1",
          title: "Approve command execution",
        },
      },
    ]);

    expect(broker.resolve("permission-1", "allow_once")).toBe(true);
    await expect(request).resolves.toBe("allow_once");

    expect(socket.pushedEvents).toMatchObject([
      {
        kind: "permission.requested",
      },
      {
        kind: "permission.resolved",
        payload: {
          outcome: "allow_once",
          permissionRequests: [],
          requestId: "permission-1",
        },
      },
    ]);
  });

  test("rejects unsupported interactive permission requests instead of allowing them", async () => {
    const broker = new DriverPermissionBroker(() => null, { interactiveRequests: false });
    const socket = createRecordingSocket();

    await expect(
      broker.request(socket, {
        rawInput: '{"command":"fd ."}',
        requestId: "permission-1",
        title: "Approve command execution",
        toolCallId: "tool-1",
        toolKind: "bash",
      }),
    ).resolves.toBe("reject_once");

    expect(broker.capabilityStatus()).toBe("unsupported");
    expect(socket.pushedEvents).toEqual([]);
  });

  test("marks pending permission requests as cancelled when rejecting all", async () => {
    const broker = new DriverPermissionBroker(() => null);
    const socket = createRecordingSocket();

    const request = broker.request(socket, {
      rawInput: '{"command":"fd ."}',
      requestId: "permission-1",
      title: "Approve command execution",
      toolCallId: "tool-1",
      toolKind: "bash",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    broker.rejectAll();

    await expect(request).resolves.toBe("reject_once");
    expect(socket.pushedEvents).toMatchObject([
      {
        kind: "permission.requested",
      },
      {
        kind: "permission.resolved",
        payload: {
          outcome: "reject_once",
          reason: "cancelled",
          requestId: "permission-1",
        },
      },
      {
        kind: "diagnostic.reported",
        payload: {
          code: "permission.cancelled",
          details: {
            requestId: "permission-1",
          },
          severity: "info",
          source: "permission",
        },
      },
    ]);
  });

  test("reports timed out permission requests explicitly", async () => {
    const broker = new DriverPermissionBroker(() => null, { requestTimeoutMs: 1 });
    const socket = createRecordingSocket();

    await expect(
      broker.request(socket, {
        rawInput: '{"command":"fd ."}',
        requestId: "permission-1",
        title: "Approve command execution",
        toolCallId: "tool-1",
        toolKind: "bash",
      }),
    ).resolves.toBe("reject_once");

    expect(socket.pushedEvents).toMatchObject([
      {
        kind: "permission.requested",
      },
      {
        kind: "permission.resolved",
        payload: {
          outcome: "reject_once",
          reason: "timed_out",
          requestId: "permission-1",
        },
      },
      {
        kind: "diagnostic.reported",
        payload: {
          code: "permission.timed_out",
          details: {
            requestId: "permission-1",
          },
          severity: "warn",
          source: "permission",
        },
      },
    ]);
  });
});
