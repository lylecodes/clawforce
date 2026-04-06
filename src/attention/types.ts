/**
 * Clawforce — Attention Item Model
 *
 * Shared model for what needs operator attention right now.
 * Powers the domain-level "Today" widget and cross-business rollup surfaces.
 */

export type AttentionUrgency = "action-needed" | "watching" | "fyi";

export type AttentionItem = {
  id: string;
  projectId: string;
  urgency: AttentionUrgency;
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
