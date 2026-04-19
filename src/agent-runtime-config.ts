import type { AgentConfig, AgentRuntimeConfig, BootstrapConfig } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return values.length > 0 ? values : undefined;
}

export function normalizeBootstrapConfig(raw: unknown): BootstrapConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const result: BootstrapConfig = {};
  const maxChars = raw.max_chars ?? raw.maxChars;
  const totalMaxChars = raw.total_max_chars ?? raw.totalMaxChars;
  if (typeof maxChars === "number" && maxChars > 0) result.maxChars = Math.floor(maxChars);
  if (typeof totalMaxChars === "number" && totalMaxChars > 0) result.totalMaxChars = Math.floor(totalMaxChars);
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeAgentRuntimeConfig(raw: unknown): AgentRuntimeConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const result: AgentRuntimeConfig = {};

  const bootstrapConfig = normalizeBootstrapConfig(raw.bootstrap_config ?? raw.bootstrapConfig);
  if (bootstrapConfig) result.bootstrapConfig = bootstrapConfig;

  const bootstrapExcludeFiles = normalizeStringList(raw.bootstrap_exclude_files ?? raw.bootstrapExcludeFiles);
  if (bootstrapExcludeFiles) result.bootstrapExcludeFiles = bootstrapExcludeFiles;

  const allowedTools = normalizeStringList(raw.allowed_tools ?? raw.allowedTools);
  if (allowedTools) result.allowedTools = allowedTools;

  const workspacePaths = normalizeStringList(raw.workspace_paths ?? raw.workspacePaths);
  if (workspacePaths) result.workspacePaths = workspacePaths;

  return Object.keys(result).length > 0 ? result : undefined;
}

export function mergeAgentRuntimeConfig(
  ...configs: Array<AgentRuntimeConfig | undefined>
): AgentRuntimeConfig | undefined {
  const merged: AgentRuntimeConfig = {};

  for (const config of configs) {
    if (!config) continue;
    if (config.bootstrapConfig) merged.bootstrapConfig = { ...config.bootstrapConfig };
    if (config.bootstrapExcludeFiles) merged.bootstrapExcludeFiles = [...config.bootstrapExcludeFiles];
    if (config.allowedTools) merged.allowedTools = [...config.allowedTools];
    if (config.workspacePaths) merged.workspacePaths = [...config.workspacePaths];
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function normalizeConfiguredAgentRuntime(raw: unknown): AgentRuntimeConfig | undefined {
  if (!isRecord(raw)) return undefined;
  return mergeAgentRuntimeConfig(
    normalizeAgentRuntimeConfig(raw),
    normalizeAgentRuntimeConfig(raw.runtime),
  );
}

export function getAgentRuntimeConfig(config?: AgentConfig | null): AgentRuntimeConfig | undefined {
  if (!config) return undefined;
  const compatibilityAliases = normalizeAgentRuntimeConfig({
    bootstrapConfig: config.bootstrapConfig,
    bootstrapExcludeFiles: config.bootstrapExcludeFiles,
    allowedTools: config.allowedTools,
    workspacePaths: config.workspacePaths,
  });
  return mergeAgentRuntimeConfig(compatibilityAliases, config.runtime);
}

export function getAgentAllowedTools(config?: AgentConfig | null): string[] | undefined {
  return getAgentRuntimeConfig(config)?.allowedTools;
}

export function getAgentWorkspacePaths(config?: AgentConfig | null): string[] | undefined {
  return getAgentRuntimeConfig(config)?.workspacePaths;
}

export function getAgentBootstrapExcludeFiles(config?: AgentConfig | null): string[] | undefined {
  return getAgentRuntimeConfig(config)?.bootstrapExcludeFiles;
}
