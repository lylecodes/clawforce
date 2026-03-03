/**
 * Clawforce skill topic — Tools
 *
 * Documents all Clawforce tools and their actions.
 * Action lists are hardcoded arrays that mirror the source tool definitions
 * (since they are not exported as constants).
 */

import { MEMORY_ACTIONS, MEMORY_CATEGORIES } from "../../tools/memory-tool.js";

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
    description: "System setup and diagnostics — explain the system, check status, validate config.",
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
    name: "clawforce_memory",
    description: "Shared memory — save and recall learnings across sessions and agents.",
    actions: MEMORY_ACTIONS,
    roleAccess: "all (when added to agent tools)",
  },
];

export function generate(): string {
  const sections: string[] = [
    "# Clawforce Tools",
    "",
    "Clawforce provides 8 tools. Each tool supports multiple actions. Access is controlled by the agent's role through action_scope policies.",
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

  // Memory-specific extras
  sections.push("## Memory Categories");
  sections.push("");
  sections.push("The `clawforce_memory` tool uses these categories for organizing memories:");
  sections.push("");
  for (const cat of MEMORY_CATEGORIES) {
    sections.push(`- \`${cat}\``);
  }
  sections.push("");

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
      list: "List all workflows for the project",
      add_task: "Add a task to a workflow phase",
      advance: "Advance to the next phase if gate condition is met",
      force_advance: "Force-advance to next phase (bypasses gate check, audited)",
      phase_status: "Get status details for a specific phase",
    },
    clawforce_setup: {
      explain: "Explain how Clawforce works (system overview)",
      status: "Show current system status and configuration",
      validate: "Validate project config for errors and warnings",
      activate: "Activate Clawforce for the current project",
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
    clawforce_memory: {
      save: "Save a learning with scope, category, and confidence",
      recall: "Query memories filtered by scope and category",
      validate: "Confirm a memory is still accurate (boosts ranking)",
      deprecate: "Mark a memory as outdated",
      list: "Browse memories by scope and category",
    },
  };

  return descriptions[tool]?.[action] ?? "No description available";
}
