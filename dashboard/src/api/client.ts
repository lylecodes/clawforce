/**
 * Clawforce REST API client.
 *
 * All endpoints are domain-scoped at /clawforce/api/:domain/:resource.
 */
import type {
  Project,
  DashboardSummary,
  Agent,
  AgentDetail,
  TaskListResponse,
  ApprovalListResponse,
  EventListResponse,
  BudgetStatus,
  BudgetForecast,
  TrustScores,
  OrgChart,
} from "./types";

const BASE = "/clawforce/api";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

function qs(params?: Record<string, string | undefined>): string {
  if (!params) return "";
  const entries = Object.entries(params).filter(
    (e): e is [string, string] => e[1] !== undefined,
  );
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries).toString();
}

export const api = {
  // -- Projects / Domains --
  getProjects: () => fetchJson<Project[]>("/projects"),

  // -- Dashboard Summary --
  getDashboard: (domain: string) =>
    fetchJson<DashboardSummary>(`/${domain}/dashboard`),

  // -- Agents --
  getAgents: (domain: string) => fetchJson<Agent[]>(`/${domain}/agents`),
  getAgent: (domain: string, agentId: string) =>
    fetchJson<AgentDetail>(`/${domain}/agents/${agentId}`),

  // -- Tasks --
  getTasks: (domain: string, params?: Record<string, string>) =>
    fetchJson<TaskListResponse>(`/${domain}/tasks${qs(params)}`),

  // -- Approvals --
  getApprovals: (domain: string, params?: Record<string, string>) =>
    fetchJson<ApprovalListResponse>(`/${domain}/approvals${qs(params)}`),
  approve: (domain: string, id: string) =>
    postJson(`/${domain}/approvals/${id}/approve`),
  reject: (domain: string, id: string, feedback?: string) =>
    postJson(`/${domain}/approvals/${id}/reject`, { feedback }),

  // -- Events --
  getEvents: (domain: string, params?: Record<string, string>) =>
    fetchJson<EventListResponse>(`/${domain}/events${qs(params)}`),

  // -- Budget --
  getBudgetStatus: (domain: string) =>
    fetchJson<BudgetStatus>(`/${domain}/budget`),
  getBudgetForecast: (domain: string) =>
    fetchJson<BudgetForecast>(`/${domain}/budget/forecast`),

  // -- Trust --
  getTrustScores: (domain: string) =>
    fetchJson<TrustScores>(`/${domain}/trust`),

  // -- Org --
  getOrgChart: (domain: string) => fetchJson<OrgChart>(`/${domain}/org`),

  // -- Actions --
  disableAgent: (domain: string, agentId: string, reason?: string) =>
    postJson(`/${domain}/agents/${agentId}/disable`, { reason }),
  enableAgent: (domain: string, agentId: string) =>
    postJson(`/${domain}/agents/${agentId}/enable`),
  reassignTask: (domain: string, taskId: string, newAssignee: string) =>
    postJson(`/${domain}/tasks/${taskId}/reassign`, { newAssignee }),
  createTask: (domain: string, data: Record<string, unknown>) =>
    postJson(`/${domain}/tasks/create`, data),
};
