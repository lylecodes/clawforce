/**
 * Clawforce -- Control API Contract
 *
 * Typed response shapes for all dashboard API endpoints.
 * The dashboard imports these types. Breaking changes require version bumps.
 *
 * Re-exports core types where possible to avoid duplication.
 */

import type { Task, ClawforceEvent } from "../types.js";
import type { DomainConfig } from "../config/schema.js";
import type { Proposal } from "../approval/resolve.js";

// Re-export referenced types for consumer convenience
export type { Task, ClawforceEvent, DomainConfig, Proposal };

// --- Agent types ---

export type OrgAgent = {
  id: string;
  extends?: string;
  title?: string;
  persona?: string;
  reports_to?: string;
  department?: string;
  team?: string;
  status?: string;
};

export type AgentSummary = {
  id: string;
  extends?: string;
  title?: string;
  persona?: string;
  department?: string;
  team?: string;
  status?: string;
  channel?: string;
};

// --- Budget types ---

export type BudgetWindowStatus = {
  window: string;
  limit?: number;
  spent?: number;
  remaining?: number;
  unit?: string;
};

// --- Read surfaces ---

export type AgentListResponse = {
  agents: AgentSummary[];
};

export type OrgChartResponse = {
  agents: OrgAgent[];
  departments: string[];
};

export type TaskListResponse = {
  tasks: Task[];
  total: number;
  hasMore: boolean;
};

export type ApprovalListResponse = {
  proposals: Proposal[];
  count: number;
};

export type BudgetStatusResponse = {
  windows?: BudgetWindowStatus[];
  alerts?: unknown[];
};

export type EventListResponse = {
  events: ClawforceEvent[];
  count: number;
};

export type HealthResponse = {
  tier: string;
  alertsFired: number;
  emergencyStop?: boolean;
  domainEnabled?: boolean;
};

export type DomainConfigResponse = {
  config: DomainConfig;
};

// --- Action surfaces ---

export type ApproveResponse = {
  ok: boolean;
};

export type TransitionResponse = {
  ok: boolean;
  error?: string;
};

export type CreateTaskResponse = {
  ok: boolean;
  taskId?: string;
};

export type ConfigSaveResponse = {
  ok: boolean;
  error?: string;
};

export type EnableDisableResponse = {
  ok: boolean;
};

export type KillResponse = {
  ok: boolean;
  killed: number;
};

// --- Capability discovery ---

export type CapabilityResponse = {
  version: string;
  features: {
    tasks: boolean;
    approvals: boolean;
    budget: boolean;
    trust: boolean;
    memory: boolean;
    experiments: boolean;
    comms: boolean;
  };
  endpoints: string[];
};
