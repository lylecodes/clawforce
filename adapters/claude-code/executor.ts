import fs from "node:fs";
import path from "node:path";
import { assembleContext } from "../../src/context/assembler.js";
import { getClawforceHome } from "../../src/paths.js";
import { getAgentConfig, getExtendedProjectConfig } from "../../src/project.js";
import type {
  DispatchExecutionRequestPort,
  DispatchExecutionResultPort,
} from "../../src/runtime/ports.js";
import { dispatchViaClaude } from "./dispatch.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDispatchMcpConfig(queueItemId: string, projectsDir: string): string {
  const tmpDir = path.join(projectsDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, `claude-dispatch-${queueItemId}-${process.pid}.json`);
  const mcpServerPath = path.resolve(import.meta.dirname, "../mcp-server.js");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      clawforce: {
        command: process.execPath,
        args: [mcpServerPath],
      },
    },
  }, null, 2));
  return configPath;
}

function cleanupDispatchMcpConfig(configPath: string): void {
  try {
    fs.unlinkSync(configPath);
  } catch {
    // best-effort cleanup
  }
}

export async function dispatchViaClaudeExecutor(
  request: DispatchExecutionRequestPort,
): Promise<DispatchExecutionResultPort> {
  const projectsDir = getClawforceHome();
  const agentEntry = getAgentConfig(request.agentId, request.projectId);
  const projectConfig = getExtendedProjectConfig(request.projectId);
  const sessionKey = `dispatch:${request.queueItemId}`;
  const systemContext = agentEntry
    ? assembleContext(request.agentId, agentEntry.config, {
      projectId: request.projectId,
      projectDir: agentEntry.projectDir,
      sessionKey,
      taskId: request.taskId,
      queueItemId: request.queueItemId,
    })
    : undefined;
  const agentClaudeConfig = isRecord(agentEntry?.config)
    && isRecord((agentEntry.config as Record<string, unknown>).claude_code)
    ? (agentEntry.config as Record<string, unknown>).claude_code as Record<string, unknown>
    : undefined;
  const mcpConfigPath = createDispatchMcpConfig(request.queueItemId, projectsDir);

  try {
    const result = await dispatchViaClaude({
      agentId: request.agentId,
      projectId: request.projectId,
      prompt: request.prompt,
      sessionKey,
      systemContext,
      timeoutMs: request.timeoutSeconds ? request.timeoutSeconds * 1000 : undefined,
      agentConfig: agentEntry?.config,
      extraEnv: {
        CLAWFORCE_PROJECTS_DIR: projectsDir,
      },
      config: {
        ...((projectConfig?.claudeCode as Record<string, unknown> | undefined) ?? {}),
        ...(agentClaudeConfig ?? {}),
        model: request.model ?? undefined,
        workdir: agentEntry?.projectDir ?? projectConfig?.projectDir ?? undefined,
        mcpConfigPath,
      },
    });

    return {
      ok: result.ok,
      executor: "claude-code",
      sessionKey: result.sessionKey,
      error: result.error,
      summary: result.result,
      completedInline: true,
    };
  } finally {
    cleanupDispatchMcpConfig(mcpConfigPath);
  }
}
