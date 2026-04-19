/**
 * ClawForce — MCP Server (stdio transport)
 *
 * Exposes all ClawForce tools via the MCP protocol over stdin/stdout.
 * Dispatch executors spawn this as a subprocess and communicate via JSON-RPC.
 *
 * Environment variables:
 *   CLAWFORCE_PROJECT_ID   — Project identifier (required)
 *   CLAWFORCE_AGENT_ID     — Agent identifier (used for session key + config lookup)
 *   CLAWFORCE_SESSION_KEY  — Session key (defaults to CLAWFORCE_AGENT_ID)
 *   CLAWFORCE_PROJECTS_DIR — Config directory (defaults to ~/.clawforce)
 */

import { createInterface } from "node:readline";
import { initClawforce } from "../src/lifecycle.js";
import { initializeAllDomains } from "../src/config/init.js";
import { getAgentConfig } from "../src/project.js";
import { createClawforceTaskTool } from "../src/tools/task-tool.js";
import { createClawforceLogTool } from "../src/tools/log-tool.js";
import { createClawforceOpsTool } from "../src/tools/ops-tool.js";
import { createClawforceVerifyTool } from "../src/tools/verify-tool.js";
import { createClawforceWorkflowTool } from "../src/tools/workflow-tool.js";
import { createClawforceSetupTool } from "../src/tools/setup-tool.js";
import { createClawforceCompactTool } from "../src/tools/compact-tool.js";
import { createClawforceContextTool } from "../src/tools/context-tool.js";
import { createClawforceMessageTool } from "../src/tools/message-tool.js";
import { createClawforceChannelTool } from "../src/tools/channel-tool.js";
import { createClawforceGoalTool } from "../src/tools/goal-tool.js";
import type { ToolResult } from "../src/tools/common.js";

const projectsDir = process.env.CLAWFORCE_PROJECTS_DIR || `${process.env.HOME}/.clawforce`;
const projectId = process.env.CLAWFORCE_PROJECT_ID;
const agentId = process.env.CLAWFORCE_AGENT_ID;
const sessionKey = process.env.CLAWFORCE_SESSION_KEY || agentId;

let initialized = false;
function ensureInit(): void {
  if (initialized) return;
  try {
    initClawforce({
      enabled: true,
      projectsDir,
      sweepIntervalMs: 0,
      defaultMaxRetries: 3,
      verificationRequired: true,
    });
    initializeAllDomains(projectsDir);
    initialized = true;
  } catch (err) {
    process.stderr.write(`[clawforce-mcp] Init error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

function buildToolRegistry(): ToolDef[] {
  ensureInit();

  const entry = agentId ? getAgentConfig(agentId) : null;
  const resolvedProjectId = projectId || entry?.projectId;
  const projectDir = entry?.projectDir;

  const factories: Array<{ create: () => { name: string; description: string; parameters: unknown; execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult> } }> = [
    {
      create: () => createClawforceTaskTool({
        agentSessionKey: sessionKey,
        projectId: resolvedProjectId,
      }),
    },
    {
      create: () => createClawforceLogTool({
        agentSessionKey: sessionKey,
        agentId: agentId ?? sessionKey,
        projectId: resolvedProjectId,
      }),
    },
    {
      create: () => createClawforceOpsTool({
        agentSessionKey: sessionKey,
        projectId: resolvedProjectId,
        projectDir,
      }),
    },
    {
      create: () => createClawforceVerifyTool({
        agentSessionKey: sessionKey,
        projectId: resolvedProjectId,
      }),
    },
    {
      create: () => createClawforceWorkflowTool({
        agentSessionKey: sessionKey,
        projectId: resolvedProjectId,
      }),
    },
    {
      create: () => createClawforceSetupTool({
        projectsDir,
        agentId: agentId ?? undefined,
      }),
    },
    {
      create: () => {
        if (!projectDir) {
          return {
            name: "clawforce_compact",
            description: "Session compaction tool (requires project configuration).",
            parameters: {},
            execute: async () => ({
              content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "No project directory configured." }) }],
              details: null,
            }),
          };
        }
        return createClawforceCompactTool({
          projectDir,
          agentSessionKey: sessionKey,
          agentId: agentId ?? undefined,
        });
      },
    },
    {
      create: () => createClawforceContextTool({
        agentSessionKey: sessionKey,
        projectId: resolvedProjectId,
        projectDir,
      }),
    },
    {
      create: () => createClawforceMessageTool({
        agentSessionKey: sessionKey,
        agentId: agentId ?? undefined,
        projectId: resolvedProjectId,
      }),
    },
    {
      create: () => createClawforceChannelTool({
        agentSessionKey: sessionKey,
        projectId: resolvedProjectId,
      }),
    },
    {
      create: () => createClawforceGoalTool({
        agentSessionKey: sessionKey,
        projectId: resolvedProjectId,
      }),
    },
  ];

  const tools: ToolDef[] = [];
  for (const factory of factories) {
    try {
      const tool = factory.create();
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: toJsonSchema(tool.parameters),
        execute: tool.execute,
      });
    } catch (err) {
      process.stderr.write(`[clawforce-mcp] Tool factory error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return tools;
}

function toJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const raw = JSON.parse(JSON.stringify(schema));
  return { type: "object", ...raw };
}

let toolRegistry: ToolDef[] | null = null;
function getTools(): ToolDef[] {
  if (!toolRegistry) {
    toolRegistry = buildToolRegistry();
  }
  return toolRegistry;
}

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function sendResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function sendError(id: string | number | null, code: number, message: string): void {
  sendResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const { id, method, params } = request;

  switch (method) {
    case "initialize": {
      sendResponse({
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "clawforce",
            version: "0.2.0",
          },
        },
      });
      break;
    }

    case "notifications/initialized": {
      break;
    }

    case "tools/list": {
      const tools = getTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      sendResponse({
        jsonrpc: "2.0",
        id: id ?? null,
        result: { tools },
      });
      break;
    }

    case "tools/call": {
      const name = params?.name;
      const toolCallId = typeof params?._meta === "object" && params?._meta && "toolCallId" in params._meta
        ? String((params._meta as Record<string, unknown>).toolCallId)
        : `mcp-${Date.now()}`;
      const args = (params?.arguments && typeof params.arguments === "object")
        ? params.arguments as Record<string, unknown>
        : {};

      if (typeof name !== "string") {
        sendError(id ?? null, -32602, "Missing tool name");
        break;
      }

      const tool = getTools().find((t) => t.name === name);
      if (!tool) {
        sendError(id ?? null, -32601, `Unknown tool: ${name}`);
        break;
      }

      try {
        const result = await tool.execute(toolCallId, args);
        sendResponse({
          jsonrpc: "2.0",
          id: id ?? null,
          result,
        });
      } catch (err) {
        sendResponse({
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            content: [{ type: "text", text: JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }) }],
            isError: true,
          },
        });
      }
      break;
    }

    default: {
      sendError(id ?? null, -32601, `Unknown method: ${method}`);
      break;
    }
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    void handleRequest(request);
  } catch (err) {
    process.stderr.write(`[clawforce-mcp] Parse error: ${err instanceof Error ? err.message : String(err)}\n`);
    sendError(null, -32700, "Parse error");
  }
});

rl.on("close", () => {
  process.exit(0);
});
