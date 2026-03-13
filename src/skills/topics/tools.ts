/**
 * Clawforce skill topic — Tools
 *
 * Documents all Clawforce tools and their actions.
 * Action lists are hardcoded arrays that mirror the source tool definitions
 * (since they are not exported as constants).
 */

import type { ActionScope } from "../../types.js";

// These action arrays mirror the source tool implementations.
// If the source changes, these must be updated to match.
const TASK_ACTIONS = [
  "create", "transition", "attach_evidence", "get", "list", "history",
  "fail", "get_approval_context", "submit_proposal", "check_proposal",
  "metrics", "bulk_create", "bulk_transition",
] as const;

const LOG_ACTIONS = [
  "write", "outcome", "search", "list", "verify_audit",
] as const;

const VERIFY_ACTIONS = [
  "request", "verdict",
] as const;

const WORKFLOW_ACTIONS = [
  "create", "get", "list", "add_task", "advance", "force_advance", "phase_status",
] as const;

const SETUP_ACTIONS = [
  "explain", "status", "validate", "activate",
] as const;

const COMPACT_ACTIONS = [
  "update_doc", "read_doc",
] as const;

const OPS_ACTIONS = [
  "agent_status", "kill_agent", "disable_agent", "enable_agent", "reassign",
  "query_audit", "trigger_sweep", "dispatch_worker", "refresh_context",
  "emit_event", "list_events", "enqueue_work", "queue_status", "process_events",
  "dispatch_metrics",
] as const;

const MEMORY_SEARCH_ACTIONS = ["search"] as const;

const MEMORY_GET_ACTIONS = ["get"] as const;

type ToolDef = {
  name: string;
  description: string;
  actions: readonly string[];
  roleAccess: string;
};

const TOOLS: ToolDef[] = [
  {
    name: "clawforce_task",
    description: "Task management — create, transition, evidence, proposals, and metrics.",
    actions: TASK_ACTIONS,
    roleAccess: "manager, employee",
  },
  {
    name: "clawforce_log",
    description: "Journal and audit log — write entries, record outcomes, and search history.",
    actions: LOG_ACTIONS,
    roleAccess: "manager, employee, scheduled",
  },
  {
    name: "clawforce_verify",
    description: "Verification requests and verdicts for task review.",
    actions: VERIFY_ACTIONS,
    roleAccess: "manager, employee",
  },
  {
    name: "clawforce_workflow",
    description: "Multi-phase workflow management — create, advance, and inspect workflows.",
    actions: WORKFLOW_ACTIONS,
    roleAccess: "manager",
  },
  {
    name: "clawforce_setup",
    description: "System setup and diagnostics — explain the system, check status, validate config, and scaffold domains via `clawforce init`.",
    actions: SETUP_ACTIONS,
    roleAccess: "manager",
  },
  {
    name: "clawforce_compact",
    description: "Session compaction — update and read context documents to persist learnings.",
    actions: COMPACT_ACTIONS,
    roleAccess: "manager, employee",
  },
  {
    name: "clawforce_ops",
    description: "Operations and management — agent lifecycle, auditing, dispatch, events, and sweeps.",
    actions: OPS_ACTIONS,
    roleAccess: "manager",
  },
  {
    name: "memory_search",
    description: "OpenClaw RAG memory — semantic search for relevant memories from previous sessions.",
    actions: MEMORY_SEARCH_ACTIONS,
    roleAccess: "all",
  },
  {
    name: "memory_get",
    description: "OpenClaw RAG memory — retrieve a specific memory entry by ID.",
    actions: MEMORY_GET_ACTIONS,
    roleAccess: "all",
  },
];

export function generate(): string {
  const sections: string[] = [
    "# Clawforce Tools",
    "",
    `Clawforce provides ${TOOLS.length} tools. Each tool supports multiple actions. Access is controlled by the agent's role through action_scope policies.`,
    "",
    "## Tool Summary",
    "",
    "| Tool | Actions | Default Access |",
    "| --- | --- | --- |",
  ];

  for (const tool of TOOLS) {
    sections.push(`| \`${tool.name}\` | ${tool.actions.length} actions | ${tool.roleAccess} |`);
  }

  sections.push("");

  // Detailed sections for each tool
  for (const tool of TOOLS) {
    sections.push(`## \`${tool.name}\``);
    sections.push("");
    sections.push(tool.description);
    sections.push("");
    sections.push("### Actions");
    sections.push("");

    for (const action of tool.actions) {
      const desc = getActionDescription(tool.name, action as string);
      sections.push(`- **\`${action}\`**: ${desc}`);
    }

    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Generate a role-scoped tools reference filtered by an ActionScope.
 * Only documents tools and actions the agent can actually use.
 */
export function generateScoped(scope: ActionScope): string {
  // Filter TOOLS to those present in the scope
  const scopedTools: Array<{ tool: ToolDef; actions: readonly string[] }> = [];

  for (const tool of TOOLS) {
    const allowed = scope[tool.name];
    if (allowed === undefined) continue; // tool not in scope — hidden

    let actions: readonly string[];
    if (allowed === "*") {
      actions = tool.actions;
    } else if (Array.isArray(allowed)) {
      actions = tool.actions.filter((a) => allowed.includes(a));
      if (actions.length === 0) continue; // no allowed actions — hide tool
    } else {
      // ActionConstraint — unwrap .actions
      const constraint = allowed.actions;
      actions = constraint === "*" ? tool.actions : tool.actions.filter((a) => constraint.includes(a));
      if (actions.length === 0) continue;
    }

    scopedTools.push({ tool, actions });
  }

  if (scopedTools.length === 0) {
    return "## Your Tools\n\nNo Clawforce tools are available for your role.";
  }

  const totalActions = scopedTools.reduce((sum, t) => sum + t.actions.length, 0);

  const sections: string[] = [
    "## Your Tools",
    "",
    `Clawforce provides ${scopedTools.length} tool${scopedTools.length === 1 ? "" : "s"} for your role (${totalActions} action${totalActions === 1 ? "" : "s"} total).`,
    "",
  ];

  for (const { tool, actions } of scopedTools) {
    sections.push(`### \`${tool.name}\``);
    sections.push("");
    sections.push(tool.description);
    sections.push("");

    for (const action of actions) {
      const desc = getActionDescription(tool.name, action as string);
      sections.push(`- **\`${action}\`**: ${desc}`);
    }

    sections.push("");
  }

  return sections.join("\n");
}

function getActionDescription(tool: string, action: string): string {
  const descriptions: Record<string, Record<string, string>> = {
    clawforce_task: {
      create: "Create a new task with title, description, priority, and optional assignee",
      transition: "Move a task to a new state (follows state machine rules)",
      attach_evidence: "Attach evidence to a task (required before REVIEW)",
      get: "Get a task by ID with full details",
      list: "List tasks with optional filters (state, assignee, priority)",
      history: "Get the transition history for a task",
      fail: "Fail a task with a reason (shortcut for transition to FAILED)",
      get_approval_context: "Get proposal details and approval policy for a decision",
      submit_proposal: "Submit a proposal for approval",
      check_proposal: "Check the status of a submitted proposal",
      metrics: "Get task metrics (completion rate, velocity, etc.)",
      bulk_create: "Create multiple tasks at once",
      bulk_transition: "Transition multiple tasks at once",
    },
    clawforce_log: {
      write: "Write a journal entry (general-purpose logging)",
      outcome: "Record the outcome of a session or job",
      search: "Search log entries by text",
      list: "List recent log entries",
      verify_audit: "Verify audit trail integrity",
    },
    clawforce_verify: {
      request: "Request verification of a task (sends to verifier)",
      verdict: "Submit a verification verdict (approve, reject, rework)",
    },
    clawforce_workflow: {
      create: "Create a new multi-phase workflow",
      get: "Get workflow details and current phase",
      list: "List all workflows for the domain",
      add_task: "Add a task to a workflow phase",
      advance: "Advance to the next phase if gate condition is met",
      force_advance: "Force-advance to next phase (bypasses gate check, audited)",
      phase_status: "Get status details for a specific phase",
    },
    clawforce_setup: {
      explain: "Explain how Clawforce works (system overview)",
      status: "Show current system status and domain configuration",
      validate: "Validate domain config for errors and warnings",
      activate: "Activate Clawforce for the current domain (initDomain — scaffolds DB, registers agents)",
    },
    clawforce_compact: {
      update_doc: "Update a context document with new content (persists learnings)",
      read_doc: "Read the current contents of a context document",
    },
    clawforce_ops: {
      agent_status: "Get status of all agents or a specific agent",
      kill_agent: "Terminate an agent session immediately",
      disable_agent: "Disable an agent (prevents future sessions)",
      enable_agent: "Re-enable a previously disabled agent",
      reassign: "Reassign a task to a different agent",
      query_audit: "Query the audit trail with filters",
      trigger_sweep: "Manually trigger a sweep cycle",
      dispatch_worker: "Dispatch a worker agent for a task",
      refresh_context: "Refresh an agent's context (re-injects briefing)",
      emit_event: "Emit a custom event into the event system",
      list_events: "List events with optional filters",
      enqueue_work: "Add work items to the dispatch queue",
      queue_status: "Get dispatch queue status",
      process_events: "Process pending events through the event router",
      dispatch_metrics: "Get dispatch and queue metrics",
    },
    memory_search: {
      search: "Semantic search for relevant memories using hybrid BM25 + vector similarity",
    },
    memory_get: {
      get: "Retrieve a specific memory entry by its ID",
    },
  };

  return descriptions[tool]?.[action] ?? "No description available";
}
