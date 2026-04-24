import { getAgentAllowedTools, getAgentWorkspacePaths } from "../agent-runtime-config.js";
import { getAgentConfig, getExtendedProjectConfig } from "../project.js";
import type { AgentConfig, DispatchExecutorName } from "../types.js";

export type EnforcementGrade = "hard-scoped" | "partially-scoped" | "policy-only";
export type ExecutorSuitability = "preferred" | "acceptable" | "avoid";

export type AgentRuntimeScopeAssessment = {
  agentId: string;
  configuredExecutor: DispatchExecutorName;
  executor: DispatchExecutorName;
  enforcementGrade: EnforcementGrade;
  executorSuitability: ExecutorSuitability;
  toolFilteringRequested: boolean;
  pathAllowlistRequested: boolean;
  bashExcluded: boolean;
  writeRestricted: boolean;
  notes: string[];
};

export type AgentRuntimeScopeAssessmentOptions = {
  configuredExecutor?: DispatchExecutorName;
  explicitExecutorConfigured?: boolean;
};

const DIRECT_EXECUTOR_DEFAULT_ALLOWED_TOOLS: Partial<Record<DispatchExecutorName, readonly string[]>> = {
  codex: ["Bash", "Read", "Edit", "Write", "WebSearch"],
  "claude-code": ["Bash", "Read", "Edit", "Write", "WebSearch"],
};

function normalizeToolNames(values: string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values
    .map((value) => value.trim())
    .filter((value) => value.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function usesNativeToolEnvelope(
  executor: DispatchExecutorName,
  allowedTools: string[] | undefined,
): boolean {
  const normalizedAllowedTools = normalizeToolNames(allowedTools);
  const nativeTools = DIRECT_EXECUTOR_DEFAULT_ALLOWED_TOOLS[executor];
  if (!nativeTools || normalizedAllowedTools.length === 0) {
    return false;
  }

  const normalizedNativeTools = normalizeToolNames([...nativeTools]);
  return normalizedAllowedTools.length === normalizedNativeTools.length
    && normalizedAllowedTools.every((tool, index) => tool === normalizedNativeTools[index]);
}

export function resolveConfiguredDispatchExecutorName(projectId: string): DispatchExecutorName {
  const config = getExtendedProjectConfig(projectId);
  const configured = config?.dispatch?.executor;
  if (configured) {
    return configured;
  }
  if (config?.adapter === "codex") {
    return "codex";
  }
  if (config?.adapter === "openclaw") {
    return "openclaw";
  }
  if (config?.adapter === "claude-code") {
    return "claude-code";
  }
  return "codex";
}

export function assessAgentRuntimeScope(
  projectId: string,
  agentId: string,
  agentConfig?: AgentConfig | null,
  options?: AgentRuntimeScopeAssessmentOptions,
): AgentRuntimeScopeAssessment {
  const projectConfig = getExtendedProjectConfig(projectId);
  const configuredExecutor = options?.configuredExecutor ?? resolveConfiguredDispatchExecutorName(projectId);
  const explicitExecutorConfigured = options?.explicitExecutorConfigured ?? Boolean(projectConfig?.dispatch?.executor);
  const config = agentConfig ?? getAgentConfig(agentId, projectId)?.config ?? null;
  const allowedTools = getAgentAllowedTools(config);
  const workspacePaths = getAgentWorkspacePaths(config);

  const toolFilteringRequested = Boolean(allowedTools?.length)
    && !usesNativeToolEnvelope(configuredExecutor, allowedTools);
  const pathAllowlistRequested = Boolean(workspacePaths?.length);
  const bashExcluded = toolFilteringRequested && !allowedTools!.includes("Bash");
  const writeRestricted = toolFilteringRequested
    && !(allowedTools!.includes("Edit") || allowedTools!.includes("Write"));
  const executor = configuredExecutor;

  const enforcementGrade = resolveEnforcementGrade({
    executor,
    toolFilteringRequested,
    pathAllowlistRequested,
  });
  const executorSuitability = resolveExecutorSuitability({
    executor,
    toolFilteringRequested,
    enforcementGrade,
  });

  const notes: string[] = [];
  if (executor === "openclaw" && toolFilteringRequested) {
    notes.push("OpenClaw enforces allowedTools at runtime for external tools via before_tool_call.");
  }
  if (executor === "codex" && toolFilteringRequested) {
    notes.push("Direct Codex still cannot fully hard-disable Bash or exactly match an allowedTools envelope.");
  }
  if (executor === "claude-code" && toolFilteringRequested) {
    notes.push("Direct Claude Code still cannot fully hard-disable Bash or exactly match an allowedTools envelope.");
  }
  if (pathAllowlistRequested && executor === "codex") {
    notes.push("Direct Codex is scoped to explicit workspace roots and companion roots only.");
  }
  if (pathAllowlistRequested && executor === "claude-code") {
    notes.push("Direct Claude Code is scoped to the configured workdir, but companion roots are not enforced as tightly as direct Codex.");
  }
  if (writeRestricted && executor === "codex") {
    notes.push("Direct Codex runs this agent in read-only mode because Edit/Write are not allowed.");
  }
  if (!toolFilteringRequested && !pathAllowlistRequested) {
    notes.push("No explicit runtime scoping is configured for this agent.");
  }

  return {
    agentId,
    configuredExecutor,
    executor,
    enforcementGrade,
    executorSuitability,
    toolFilteringRequested,
    pathAllowlistRequested,
    bashExcluded,
    writeRestricted,
    notes,
  };
}

function resolveEnforcementGrade(input: {
  executor: DispatchExecutorName;
  toolFilteringRequested: boolean;
  pathAllowlistRequested: boolean;
}): EnforcementGrade {
  if (!input.toolFilteringRequested && !input.pathAllowlistRequested) {
    return "policy-only";
  }
  if (input.executor === "openclaw") {
    return "hard-scoped";
  }
  if (input.executor === "codex") {
    return input.toolFilteringRequested ? "partially-scoped" : "hard-scoped";
  }
  return "partially-scoped";
}

function resolveExecutorSuitability(input: {
  executor: DispatchExecutorName;
  toolFilteringRequested: boolean;
  enforcementGrade: EnforcementGrade;
}): ExecutorSuitability {
  if (!input.toolFilteringRequested) {
    return input.enforcementGrade === "policy-only" ? "acceptable" : "preferred";
  }
  if (input.executor === "openclaw") {
    return "preferred";
  }
  return "avoid";
}
