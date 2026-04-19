import type { AgentConfig, Channel, CronSchedule, Message } from "../types.js";
import type { NotificationRecord } from "../notifications/types.js";

export type DispatchInjectorPort = (
  params: { sessionKey: string; message: string }
) => Promise<{ runId?: string }>;

export type DispatchExecutionRequestPort = {
  queueItemId: string;
  taskId: string;
  projectId: string;
  prompt: string;
  agentId: string;
  jobName?: string;
  model?: string;
  timeoutSeconds?: number;
  agentConfig?: AgentConfig;
  projectDir?: string;
  disableMcpBridge?: boolean;
};

export type DispatchExecutionResultPort = {
  ok: boolean;
  executor: string;
  sessionKey?: string;
  error?: string;
  summary?: string;
  summarySynthetic?: boolean;
  observedWork?: boolean;
  handledRemotely?: boolean;
  completedInline?: boolean;
  deferred?: boolean;
};

export type DispatchExecutorPort = {
  id: string;
  dispatch(
    request: DispatchExecutionRequestPort,
  ): Promise<DispatchExecutionResultPort>;
};

export type DeliveryAdapterPort = {
  send(
    channel: string,
    content: string,
    target: Record<string, unknown>,
    options?: { buttons?: unknown[]; format?: string },
  ): Promise<{ sent: boolean; messageId?: string; error?: string }>;
  edit?(
    channel: string,
    messageId: string,
    content: string,
    target: Record<string, unknown>,
  ): Promise<{ sent: boolean; error?: string }>;
};

export type ApprovalNotificationPayloadPort = {
  proposalId: string;
  projectId: string;
  title: string;
  description?: string;
  proposedBy: string;
  riskTier?: string;
  toolContext?: {
    toolName: string;
    category?: string;
    taskId?: string;
  };
};

export type ApprovalNotificationResultPort = {
  sent: boolean;
  channel: "inline" | "telegram" | "slack" | "discord" | "dashboard";
  messageId?: string;
  error?: string;
};

export type ApprovalNotifierPort = {
  sendProposalNotification(
    payload: ApprovalNotificationPayloadPort,
  ): Promise<ApprovalNotificationResultPort>;
  editProposalMessage(
    proposalId: string,
    projectId: string,
    resolution: "approved" | "rejected",
    feedback?: string,
  ): Promise<void>;
};

export type MessagePort = Message;

export type ChannelPort = Channel;

export type MessageNotifierPort = {
  sendMessageNotification(
    message: MessagePort,
  ): Promise<{ sent: boolean; error?: string }>;
};

export type ChannelNotifierPort = {
  sendChannelNotification(params: {
    channel: ChannelPort;
    message: MessagePort;
  }): Promise<{ sent: boolean; error?: string }>;
};

export type NotificationRecordPort = NotificationRecord;

export type NotificationDeliveryAdapterPort = (
  record: NotificationRecordPort,
) => Promise<void>;

export type AgentKillPort = (
  sessionKey: string,
  reason: string,
) => Promise<boolean>;

export type CronJobStatePort = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
  lastDeliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
  lastDeliveryError?: string;
};

export type CronJobRecordPort = {
  id: string;
  name: string;
  agentId?: string;
  enabled: boolean;
  description?: string;
  schedule: CronSchedule;
  state: CronJobStatePort;
  deleteAfterRun?: boolean;
};

export type CronServicePort = {
  list(opts?: { includeDisabled?: boolean }): Promise<CronJobRecordPort[]>;
  add(input: Record<string, unknown>): Promise<unknown>;
  update(id: string, patch: Record<string, unknown>): Promise<unknown>;
  remove?(id: string): Promise<unknown>;
  run?(id: string): Promise<unknown>;
};

export type DiagnosticPayloadPort = Record<string, unknown>;

export type DiagnosticEmitterPort = (
  payload: DiagnosticPayloadPort,
) => void;

export type SSEManagerPort = {
  addClient(...args: any[]): string;
  removeClient(domain: string, clientId: string): void;
  broadcast(domain: string, event: string, data: unknown): void;
  clientCount(domain: string): number;
};

export type OpenClawAgentEntry = {
  id: string;
  model?: string | { primary?: string; fallbacks?: string[] };
  tools?: string[];
  [key: string]: unknown;
};

export type OpenClawModelEntry = {
  id: string;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  [key: string]: unknown;
};

export type OpenClawProviderEntry = {
  id: string;
  models?: OpenClawModelEntry[];
  rpm?: number;
  tpm?: number;
  [key: string]: unknown;
};

export type OpenClawConfigSnapshot = {
  agents?: {
    list?: OpenClawAgentEntry[];
    defaults?: { model?: string | { primary?: string; fallbacks?: string[] }; [key: string]: unknown };
  };
  models?: {
    providers?: OpenClawProviderEntry[];
  };
  [key: string]: unknown;
};

export type OpenClawMeetingSession = {
  channelId: string;
  turnIndex: number;
  projectId: string;
};

export type OpenClawSessionState = {
  memoryModeBySession: Map<string, boolean>;
  sessionTurnCounts: Map<string, number>;
  meetingSessions: Map<string, OpenClawMeetingSession>;
};

export type RuntimeIntegrationState = {
  deliveryAdapter: DeliveryAdapterPort | null;
  approvalNotifier: ApprovalNotifierPort | null;
  messageNotifier: MessageNotifierPort | null;
  channelNotifier: ChannelNotifierPort | null;
  notificationDeliveryAdapter: NotificationDeliveryAdapterPort | null;
  killFunction: AgentKillPort | null;
  dispatchInjector: DispatchInjectorPort | null;
  cronService: CronServicePort | null;
  diagnosticEmitter: DiagnosticEmitterPort | null;
  sseManager: SSEManagerPort | null;
  openClawConfigSnapshot: OpenClawConfigSnapshot | null;
  dispatchExecutors: Map<string, DispatchExecutorPort>;
};
