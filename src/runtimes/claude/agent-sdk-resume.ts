import type { DriverStartInput } from "../../protocol/start";

export function readClaudeNativeResumeSessionId(payload: DriverStartInput): string | null {
  const { nativeResumeRef } = payload.execution.session;

  if (!nativeResumeRef) {
    return null;
  }

  if (
    nativeResumeRef.runtimeId !== "claude-agent-sdk" ||
    nativeResumeRef.kind !== "claude_session_id"
  ) {
    throw new Error("Claude runtime received an incompatible native resume ref.");
  }

  return nativeResumeRef.value;
}
