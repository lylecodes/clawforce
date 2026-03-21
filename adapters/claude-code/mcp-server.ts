/**
 * Clawforce — MCP server skeleton for Claude Code
 *
 * Exposes ClawForce tools as an MCP (Model Context Protocol) server.
 * Claude Code connects to this server to gain access to ClawForce capabilities
 * (task management, logging, verification, workflows, etc.).
 *
 * Phase 1: Server skeleton with tool listing. Tool execution wiring is Phase 2.
 */

import http from "node:http";

// --- Tool Definitions ---

/**
 * MCP tool descriptor matching the Model Context Protocol schema.
 * See: https://modelcontextprotocol.io/docs/concepts/tools
 */
export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

/**
 * Registry of ClawForce tools exposed via MCP.
 * Each entry maps a tool name to its MCP-compatible schema.
 *
 * These correspond to the tools in src/tools/*.ts:
 * - clawforce_task: Task lifecycle management (create, transition, get, list, etc.)
 * - clawforce_log: Knowledge logging and audit trail (write, outcome, search, list)
 * - clawforce_verify: Cross-team task verification (request, verdict)
 * - clawforce_workflow: Multi-step workflow management (create, advance, status)
 * - clawforce_ops: Runtime observability and control (status, kill, disable, metrics)
 * - clawforce_setup: Project initialization and scaffolding
 * - clawforce_compact: Session compaction for long-running agents
 * - clawforce_context: Context source management and injection
 * - clawforce_message: Inter-agent messaging
 * - clawforce_channel: Channel-based group communication
 */
export const CLAWFORCE_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "clawforce_task",
    description:
      "Task lifecycle management. Actions: create, transition, get, list, " +
      "attach_evidence, history, fail, metrics, bulk_create, bulk_transition, " +
      "add_dep, remove_dep, list_deps, list_dependents, list_blockers.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform on the task system." },
        project_id: { type: "string", description: "Project identifier." },
        task_id: { type: "string", description: "Task ID." },
        title: { type: "string", description: "Task title (for create)." },
        description: { type: "string", description: "Task description." },
        priority: { type: "string", description: "Priority: P0, P1, P2, P3." },
        assigned_to: { type: "string", description: "Agent to assign." },
        to_state: { type: "string", description: "Target state (for transition)." },
        reason: { type: "string", description: "Reason for transition or failure." },
      },
      required: ["action"],
    },
  },
  {
    name: "clawforce_log",
    description:
      "Knowledge logging and audit trail. Actions: write, outcome, search, list, " +
      "verify_audit, record_decision.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform." },
        project_id: { type: "string", description: "Project identifier." },
        category: { type: "string", description: "Entry category: decision, pattern, issue, outcome, context." },
        title: { type: "string", description: "Entry title." },
        content: { type: "string", description: "Entry content." },
        query: { type: "string", description: "Search query text." },
      },
      required: ["action"],
    },
  },
  {
    name: "clawforce_verify",
    description:
      "Cross-team task verification. Actions: request (dispatch verifier), " +
      "verdict (submit PASS/FAIL).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action: request or verdict." },
        task_id: { type: "string", description: "Task ID to verify." },
        passed: { type: "boolean", description: "Verdict: true for PASS, false for FAIL." },
        reason: { type: "string", description: "Reason for the verdict." },
      },
      required: ["action", "task_id"],
    },
  },
  {
    name: "clawforce_workflow",
    description:
      "Multi-step workflow management. Actions: create, advance, status, list.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform." },
        project_id: { type: "string", description: "Project identifier." },
        workflow_id: { type: "string", description: "Workflow identifier." },
        name: { type: "string", description: "Workflow name (for create)." },
      },
      required: ["action"],
    },
  },
  {
    name: "clawforce_ops",
    description:
      "Runtime observability and control. Actions: status, kill, disable, enable, " +
      "reassign, audit, sweep, metrics, dispatch, queue_status, budget.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform." },
        project_id: { type: "string", description: "Project identifier." },
        agent_id: { type: "string", description: "Target agent ID." },
        reason: { type: "string", description: "Reason for the action." },
      },
      required: ["action"],
    },
  },
  {
    name: "clawforce_setup",
    description:
      "Project initialization and scaffolding. Actions: init, scaffold, status.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform." },
        project_dir: { type: "string", description: "Directory to initialize." },
        domain: { type: "string", description: "Domain name." },
      },
      required: ["action"],
    },
  },
  {
    name: "clawforce_compact",
    description:
      "Session compaction for long-running agents. Summarizes conversation history " +
      "to reduce context window usage.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action: compact." },
      },
      required: ["action"],
    },
  },
  {
    name: "clawforce_context",
    description:
      "Context source management. Actions: list, get, add, remove. " +
      "Manages context sources that are injected into agent prompts.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform." },
        project_id: { type: "string", description: "Project identifier." },
        source_id: { type: "string", description: "Context source identifier." },
      },
      required: ["action"],
    },
  },
  {
    name: "clawforce_message",
    description:
      "Inter-agent messaging. Actions: send, inbox, read. " +
      "Enables agents to communicate asynchronously.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform." },
        to: { type: "string", description: "Recipient agent ID." },
        content: { type: "string", description: "Message content." },
      },
      required: ["action"],
    },
  },
  {
    name: "clawforce_channel",
    description:
      "Channel-based group communication. Actions: create, send, list, history, join, leave.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action to perform." },
        channel_id: { type: "string", description: "Channel identifier." },
        content: { type: "string", description: "Message content." },
      },
      required: ["action"],
    },
  },
];

// --- MCP Server ---

export type McpServerOptions = {
  /** Port to listen on (default: 3118). */
  port?: number;
  /** Hostname to bind (default: "127.0.0.1"). */
  host?: string;
  /** Project ID for tool execution context. */
  projectId?: string;
  /** Agent ID for tool execution context. */
  agentId?: string;
};

/**
 * Create an MCP server that exposes ClawForce tools.
 *
 * Phase 1: Returns tool listings via tools/list.
 * Phase 2 will add tool execution via tools/call.
 */
export function createMcpServer(options?: McpServerOptions) {
  const port = options?.port ?? 3118;
  const host = options?.host ?? "127.0.0.1";
  let server: http.Server | null = null;

  /**
   * Handle an MCP JSON-RPC request.
   * Implements the MCP protocol subset needed for tool serving.
   */
  function handleMcpRequest(body: unknown): unknown {
    if (typeof body !== "object" || body === null) {
      return { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: null };
    }

    const req = body as { jsonrpc?: string; method?: string; params?: unknown; id?: unknown };

    if (req.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request: jsonrpc must be 2.0" }, id: req.id ?? null };
    }

    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: "clawforce",
              version: "0.2.0",
            },
          },
          id: req.id,
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          result: {
            tools: CLAWFORCE_MCP_TOOLS,
          },
          id: req.id,
        };

      case "tools/call": {
        // Phase 2: wire actual tool execution
        const callParams = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        const toolName = callParams?.name;
        const knownTool = CLAWFORCE_MCP_TOOLS.find((t) => t.name === toolName);

        if (!knownTool) {
          return {
            jsonrpc: "2.0",
            error: { code: -32602, message: `Unknown tool: ${toolName}` },
            id: req.id,
          };
        }

        // Skeleton response — tool execution not yet wired
        return {
          jsonrpc: "2.0",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  reason: `Tool ${toolName} is registered but execution is not yet wired (Phase 2).`,
                }),
              },
            ],
            isError: false,
          },
          id: req.id,
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          error: { code: -32601, message: `Method not found: ${req.method}` },
          id: req.id ?? null,
        };
    }
  }

  return {
    /** List all registered MCP tools. */
    listTools(): McpToolDefinition[] {
      return [...CLAWFORCE_MCP_TOOLS];
    },

    /** Handle a raw MCP JSON-RPC request body. */
    handleRequest: handleMcpRequest,

    /** Start the HTTP server for MCP over HTTP+SSE (streamable). */
    async start(): Promise<void> {
      if (server) return;

      server = http.createServer((req, res) => {
        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const response = handleMcpRequest(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32700, message: "Parse error" },
              id: null,
            }));
          }
        });
      });

      return new Promise((resolve) => {
        server!.listen(port, host, () => {
          resolve();
        });
      });
    },

    /** Stop the HTTP server. */
    async stop(): Promise<void> {
      if (!server) return;
      return new Promise((resolve) => {
        server!.close(() => {
          server = null;
          resolve();
        });
      });
    },

    /** Get the server port. */
    get port() {
      return port;
    },

    /** Get the server host. */
    get host() {
      return host;
    },
  };
}
