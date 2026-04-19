import path from "node:path";
import { getAgentAllowedTools, getAgentWorkspacePaths } from "../../src/agent-runtime-config.js";
import { assembleContext } from "../../src/context/assembler.js";
import { getClawforceHome } from "../../src/paths.js";
import { getAgentConfig, getExtendedProjectConfig } from "../../src/project.js";
import { getAgentKillPort, setAgentKillPort } from "../../src/runtime/integrations.js";
import type {
  DispatchExecutionRequestPort,
  DispatchExecutionResultPort,
} from "../../src/runtime/ports.js";
import { dispatchViaCodex, killCodexSession } from "./dispatch.js";

let codexKillBridgeInstalled = false;

function ensureCodexKillBridge(): void {
  if (codexKillBridgeInstalled) return;
  const previousKill = getAgentKillPort();
  setAgentKillPort(async (sessionKey, reason) => {
    if (await killCodexSession(sessionKey, reason)) {
      return true;
    }
    return previousKill ? previousKill(sessionKey, reason) : false;
  });
  codexKillBridgeInstalled = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function toTomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
}

function toTomlInlineStringTable(values: Record<string, string>): string {
  const entries = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  return `{${entries.join(",")}}`;
}

function resolveWorkspaceRoots(
  workspacePaths: string[] | undefined,
  fallbackProjectDir?: string,
): string[] {
  const candidates = workspacePaths && workspacePaths.length > 0
    ? workspacePaths
    : (fallbackProjectDir ? [fallbackProjectDir] : []);
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const normalized = resolveWorkspacePath(candidate, fallbackProjectDir);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    resolved.push(normalized);
  }

  return resolved;
}

function resolveWorkspacePath(candidate: string, fallbackProjectDir?: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  if (trimmed === "~") {
    return process.env.HOME ?? process.env.USERPROFILE ?? path.resolve(trimmed);
  }
  if (trimmed.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    return home ? path.join(home, trimmed.slice(2)) : path.resolve(trimmed);
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  if (fallbackProjectDir) {
    return path.resolve(fallbackProjectDir, trimmed);
  }
  return path.resolve(trimmed);
}

function agentAllowsWrites(agentConfig: DispatchExecutionRequestPort["agentConfig"]): boolean {
  const allowedTools = getAgentAllowedTools(agentConfig);
  if (!allowedTools || allowedTools.length === 0) {
    return true;
  }
  return allowedTools.includes("Edit") || allowedTools.includes("Write");
}

function createDispatchMcpConfigOverrides(
  request: DispatchExecutionRequestPort,
  projectsDir: string,
): string[] {
  const sessionKey = `dispatch:${request.queueItemId}`;
  const mcpServerPath = path.resolve(import.meta.dirname, "../mcp-server.js");
  const env = {
    CLAWFORCE_AGENT_ID: request.agentId,
    CLAWFORCE_PROJECT_ID: request.projectId,
    CLAWFORCE_PROJECTS_DIR: projectsDir,
    CLAWFORCE_SESSION_KEY: sessionKey,
  };
  return [
    `mcp_servers.clawforce.command=${toTomlString(process.execPath)}`,
    `mcp_servers.clawforce.args=${toTomlStringArray([mcpServerPath])}`,
    `mcp_servers.clawforce.env=${toTomlInlineStringTable(env)}`,
  ];
}

export async function dispatchViaCodexExecutor(
  request: DispatchExecutionRequestPort,
): Promise<DispatchExecutionResultPort> {
  ensureCodexKillBridge();
  const projectsDir = getClawforceHome();
  const projectConfig = getExtendedProjectConfig(request.projectId);
  const sessionKey = `dispatch:${request.queueItemId}`;
  const fallbackAgentEntry = request.agentConfig
    ? null
    : getAgentConfig(request.agentId, request.projectId);
  const agentConfig = request.agentConfig ?? fallbackAgentEntry?.config;
  const configuredProjectDir = request.projectDir ?? fallbackAgentEntry?.projectDir ?? projectConfig?.projectDir ?? undefined;
  const workspaceRoots = resolveWorkspaceRoots(getAgentWorkspacePaths(agentConfig), configuredProjectDir);
  const projectDir = workspaceRoots[0] ?? configuredProjectDir;
  const writableRoots = agentAllowsWrites(agentConfig) ? workspaceRoots.slice(1) : [];
  const systemContext = agentConfig
    ? assembleContext(request.agentId, agentConfig, {
      projectId: request.projectId,
      projectDir,
      sessionKey,
      taskId: request.taskId,
      queueItemId: request.queueItemId,
    })
    : undefined;
  const agentCodexConfig = isRecord(agentConfig)
    && isRecord((agentConfig as Record<string, unknown>).codex)
    ? (agentConfig as Record<string, unknown>).codex as Record<string, unknown>
    : undefined;

  const result = await dispatchViaCodex({
    agentId: request.agentId,
    projectId: request.projectId,
    prompt: request.prompt,
    sessionKey,
    taskId: request.taskId,
    queueItemId: request.queueItemId,
    jobName: request.jobName,
    systemContext,
    timeoutMs: request.timeoutSeconds ? request.timeoutSeconds * 1000 : undefined,
    agentConfig,
    mcpBridgeDisabled: request.disableMcpBridge === true,
    config: {
      ...((projectConfig?.codex as Record<string, unknown> | undefined) ?? {}),
      ...(agentCodexConfig ?? {}),
      model: request.model ?? undefined,
      workdir: projectDir,
      approvalPolicy: "never",
      fullAuto: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      sandbox: agentAllowsWrites(agentConfig) ? undefined : "read-only",
      addDirs: writableRoots,
      configOverrides: request.disableMcpBridge === true
        ? undefined
        : createDispatchMcpConfigOverrides(request, projectsDir),
    },
    extraEnv: request.disableMcpBridge === true
      ? undefined
      : {
        CLAWFORCE_PROJECTS_DIR: projectsDir,
      },
  });

  return {
    ok: result.ok,
    executor: "codex",
    sessionKey: result.sessionKey,
    error: result.error,
    summary: result.result,
    summarySynthetic: result.summarySynthetic,
    observedWork: result.observedWork,
    completedInline: true,
  };
}
