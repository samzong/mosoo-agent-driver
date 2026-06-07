import type { DriverStartInput } from "../protocol/start";
import type { AgentDriverBackend } from "./agent-driver-backend";
import { AGENT_DRIVER_PROVIDER_REGISTRY } from "./provider-registry";

export async function createAgentDriverBackend(
  input: DriverStartInput,
): Promise<AgentDriverBackend> {
  return AGENT_DRIVER_PROVIDER_REGISTRY.createBackend(input);
}
