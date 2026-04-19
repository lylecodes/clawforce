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

  const toolFilteringRequested = Boolean(allowedTools?.length);
  const pathAllowlistRequested = Boolean(workspacePaths?.length);
  const bashExcluded = toolFilteringRequested && !allowedTools!.includes("Bash");
  const writeRestricted = toolFilteringRequested
    && !(allowedTools!.includes("Edit") || allowedTools!.includes("Write"));

  const executor = !explicitExecutorConfigured
    && configuredExecutor === "codex"
    && toolFilteringRequested
    ? "openclaw"
    : configuredExecutor;

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
  if (executor !== configuredExecutor) {
    notes.push(`Auto-routed from ${configuredExecutor} to ${executor} because this agent requests explicit tool filtering.`);
  }
  if (executor === "openclaw" && toolFilteringRequested) {
    notes.push("OpenClaw enforces allowedTools at runtime for external tools via before_tool_call.");
  }
  if (executor === "codex" && toolFilteringRequested) {
    notes.push("Direct Codex still cannot fully hard-disable Bash or exactly match an allowedTools envelope.");
  }
  if (pathAllowlistRequested && executor === "codex") {
    notes.push("Direct Codex is scoped to explicit workspace roots and companion roots only.");
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
