export const BUILTIN_CLAWFORCE_TOOL_NAMES = [
  "clawforce_task",
  "clawforce_log",
  "clawforce_verify",
  "clawforce_workflow",
  "clawforce_setup",
  "clawforce_compact",
  "clawforce_ops",
  "clawforce_context",
  "clawforce_message",
  "clawforce_goal",
  "clawforce_entity",
  "clawforce_channel",
  "clawforce_config",
] as const;

export const KNOWN_TOOL_NAMES = [
  ...BUILTIN_CLAWFORCE_TOOL_NAMES,
  "memory_search",
  "memory_get",
] as const;

export const KNOWN_TOOL_NAME_SET = new Set<string>(KNOWN_TOOL_NAMES);

export function isKnownToolName(value: string): boolean {
  return KNOWN_TOOL_NAME_SET.has(value);
}
