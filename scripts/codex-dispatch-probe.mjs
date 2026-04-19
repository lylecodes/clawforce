import path from "node:path";
import { initializeAllDomains } from "../dist/src/config/init.js";
import { getAgentConfig, getExtendedProjectConfig } from "../dist/src/project.js";
import { getDb } from "../dist/src/db.js";
import { getTask } from "../dist/src/tasks/ops.js";
import { buildTaskPrompt } from "../dist/src/dispatch/spawn.js";
import { buildRetryContext } from "../dist/src/dispatch/dispatcher.js";
import { assembleContext } from "../dist/src/context/assembler.js";
import { dispatchViaCodex } from "../dist/adapters/codex/dispatch.js";

const projectId = process.argv[2] ?? "rentright-data";
const taskId = process.argv[3] ?? "3d57dfd5-4dd7-4bcb-8b69-0ded903d3de8";
const agentId = process.argv[4] ?? "workflow-steward";
const clawforceHome = process.argv[5] ?? "/Users/lylejens/workplace/rentright/.clawforce";

initializeAllDomains(clawforceHome);
const db = getDb(projectId);
const task = getTask(projectId, taskId, db);
const agentEntry = getAgentConfig(agentId, projectId);
const projectConfig = getExtendedProjectConfig(projectId);

if (!task || !agentEntry) {
  throw new Error(`Missing task or agent config: task=${Boolean(task)} agent=${Boolean(agentEntry)}`);
}

const userPrompt = `Execute task: ${task.title}`;
const prompt = buildTaskPrompt(task, userPrompt);
const retryContext = buildRetryContext(projectId, taskId, db);
const fullPrompt = retryContext ? `${prompt}\n\n${retryContext}` : prompt;
const systemContext = assembleContext(agentId, agentEntry.config, {
  projectId,
  projectDir: agentEntry.projectDir ?? projectConfig?.projectDir,
  sessionKey: "dispatch:probe-shape",
});

const baseConfig = {
  ...(projectConfig?.codex ?? {}),
  workdir: agentEntry.projectDir ?? projectConfig?.projectDir,
  model: "gpt-5.4",
};

const mcpServerPath = path.resolve(import.meta.dirname, "../dist/adapters/mcp-server.js");

function mcpOverrides(queueItemId) {
  return [
    `mcp_servers.clawforce.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.clawforce.args=[${JSON.stringify(mcpServerPath)}]`,
    `mcp_servers.clawforce.env={CLAWFORCE_AGENT_ID=${JSON.stringify(agentId)},CLAWFORCE_PROJECT_ID=${JSON.stringify(projectId)},CLAWFORCE_PROJECTS_DIR=${JSON.stringify(clawforceHome)},CLAWFORCE_SESSION_KEY=${JSON.stringify(`dispatch:${queueItemId}`)}}`,
  ];
}

function summarizeResult(label, withMcp, result) {
  return {
    label,
    withMcp,
    ok: result.ok,
    summarySynthetic: result.summarySynthetic ?? null,
    observedWork: result.observedWork ?? null,
    durationMs: result.durationMs,
    stdoutChars: result.stdout?.length ?? 0,
    stderrChars: result.stderr?.length ?? 0,
    resultChars: result.result?.length ?? 0,
    error: result.error ?? null,
    stdoutPreview: (result.stdout || "").replace(/\s+/g, " ").trim().slice(0, 200),
    stderrPreview: (result.stderr || "").replace(/\s+/g, " ").trim().slice(0, 200),
    resultPreview: (result.result || "").replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

async function run(label, withMcp) {
  const queueItemId = `probe-${label}-${Date.now()}`;
  const result = await dispatchViaCodex({
    agentId,
    projectId,
    prompt: fullPrompt,
    systemContext,
    taskId,
    queueItemId,
    sessionKey: `dispatch:${queueItemId}`,
    agentConfig: agentEntry.config,
    timeoutMs: 120_000,
    config: {
      ...baseConfig,
      configOverrides: withMcp ? mcpOverrides(queueItemId) : undefined,
    },
    extraEnv: withMcp ? { CLAWFORCE_PROJECTS_DIR: clawforceHome } : undefined,
  });
  console.log(JSON.stringify(summarizeResult(label, withMcp, result), null, 2));
}

console.log(JSON.stringify({
  projectId,
  taskId,
  agentId,
  promptChars: fullPrompt.length,
  systemContextChars: systemContext.length,
  finalPromptChars: fullPrompt.length + systemContext.length,
}, null, 2));

await run("no-mcp", false);
await run("with-mcp", true);
