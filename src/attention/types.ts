/**
 * Clawforce — Attention Item Model
 *
 * Shared model for what needs operator attention right now.
 * Powers the domain-level "Today" widget and cross-business rollup surfaces.
 */

export type AttentionUrgency = "action-needed" | "watching" | "fyi";

export type AttentionKind = "info" | "issue" | "proposal" | "approval" | "alert";

export type AttentionSeverity = "critical" | "high" | "normal" | "low";

export type AttentionAutomationState =
  | "auto_handled"
  | "auto_handling"
  | "blocked_for_agent"
  | "needs_human";

export type AttentionItem = {
  id: string;
  projectId: string;
  urgency: AttentionUrgency;
  actionability: AttentionUrgency;
  kind: AttentionKind;
  severity: AttentionSeverity;
  automationState: AttentionAutomationState;
  /** "approval", "task", "budget", "health", "comms", "compliance" */
  category: string;
  title: string;
  summary: string;
  /** Route path to navigate to for this item */
  destination: string;
  /** Query params or context to pass to the destination */
  focusContext?: Record<string, string>;
  /** When this item was created/detected */
  detectedAt: number;
  /** Last time this item was updated */
  updatedAt: number;
  entityType?: string;
  entityId?: string;
  taskId?: string;
  proposalId?: string;
  issueId?: string;
  simulatedActionId?: string;
  sourceType?: string;
  sourceId?: string;
  recommendedAction?: string;
  evidence?: Record<string, unknown>;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
};

export type AttentionSummary = {
  projectId: string;
  items: AttentionItem[];
  counts: {
    actionNeeded: number;
    watching: number;
    fyi: number;
  };
  generatedAt: number;
};

export type DecisionInboxSummary = AttentionSummary;
