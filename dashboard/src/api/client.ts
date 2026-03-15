/**
 * Clawforce REST API client.
 *
 * All endpoints are domain-scoped at /api/:domain/:resource.
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
  CostResponse,
  MessageListResponse,
  ThreadMessagesResponse,
  MeetingListResponse,
  Meeting,
  DomainConfig,
  ConfigChangePreview,
  ConfigValidationResult,
  GoalListResponse,
  Goal,
} from "./types";

const BASE = "/api";

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
  getProjects: () => fetchJson<Project[]>("/domains"),

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

  // -- Costs --
  getCosts: (domain: string, params?: Record<string, string>) =>
    fetchJson<CostResponse>(`/${domain}/costs${qs(params)}`),

  // -- Org --
  getOrgChart: (domain: string) => fetchJson<OrgChart>(`/${domain}/org`),

  // -- Messages / Comms --
  getMessages: (domain: string, params?: Record<string, string>) =>
    fetchJson<MessageListResponse>(`/${domain}/messages${qs(params)}`),
  getThreadMessages: (domain: string, threadId: string) =>
    fetchJson<ThreadMessagesResponse>(`/${domain}/messages/${threadId}`),
  getMeetings: (domain: string) =>
    fetchJson<MeetingListResponse>(`/${domain}/meetings`),
  createMeeting: (domain: string, data: { participants: string[]; topic?: string }) =>
    postJson<Meeting>(`/${domain}/meetings/create`, data),
  sendMeetingMessage: (domain: string, meetingId: string, content: string) =>
    postJson(`/${domain}/meetings/${meetingId}/message`, { content }),
  endMeeting: (domain: string, meetingId: string) =>
    postJson(`/${domain}/meetings/${meetingId}/end`),
  sendThreadMessage: (domain: string, threadId: string, content: string) =>
    postJson(`/${domain}/messages/${threadId}/send`, { content }),

  // -- Goals --
  getGoals: (domain: string, params?: Record<string, string>) =>
    fetchJson<GoalListResponse>(`/${domain}/goals${qs(params)}`),
  getGoal: (domain: string, goalId: string) =>
    fetchJson<Goal>(`/${domain}/goals/${goalId}`),

  // -- Config --
  getConfig: (domain: string) =>
    fetchJson<DomainConfig>(`/${domain}/config`),
  saveConfig: (domain: string, section: string, data: unknown) =>
    postJson(`/${domain}/config/save`, { section, data }),
  validateConfig: (domain: string, section: string, data: unknown) =>
    postJson<ConfigValidationResult>(`/${domain}/config/validate`, { section, data }),
  previewConfig: (domain: string, current: unknown, proposed: unknown) =>
    postJson<ConfigChangePreview>(`/${domain}/config/preview`, { current, proposed }),

  // -- Demo --
  createDemo: () =>
    postJson<{ domainId: string; message: string }>("/demo/create"),

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
