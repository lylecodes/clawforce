import { getDefaultRuntimeState } from "./default-runtime.js";
import type {
  AgentKillPort,
  ApprovalNotifierPort,
  ChannelNotifierPort,
  CronServicePort,
  DispatchExecutorPort,
  DeliveryAdapterPort,
  DiagnosticEmitterPort,
  DispatchInjectorPort,
  MessageNotifierPort,
  NotificationDeliveryAdapterPort,
  OpenClawConfigSnapshot,
  OpenClawMeetingSession,
  OpenClawSessionState,
  RuntimeIntegrationState,
  SSEManagerPort,
} from "./ports.js";

const runtime = getDefaultRuntimeState();

function getRuntimeIntegrations(): RuntimeIntegrationState {
  return runtime.integrations;
}

export function setDeliveryAdapterPort(adapter: DeliveryAdapterPort | null): void {
  getRuntimeIntegrations().deliveryAdapter = adapter;
}

export function getDeliveryAdapterPort(): DeliveryAdapterPort | null {
  return getRuntimeIntegrations().deliveryAdapter;
}

export function clearDeliveryAdapterPort(): void {
  getRuntimeIntegrations().deliveryAdapter = null;
}

export function setApprovalNotifierPort(notifier: ApprovalNotifierPort | null): void {
  getRuntimeIntegrations().approvalNotifier = notifier;
}

export function getApprovalNotifierPort(): ApprovalNotifierPort | null {
  return getRuntimeIntegrations().approvalNotifier;
}

export function setMessageNotifierPort(notifier: MessageNotifierPort | null): void {
  getRuntimeIntegrations().messageNotifier = notifier;
}

export function getMessageNotifierPort(): MessageNotifierPort | null {
  return getRuntimeIntegrations().messageNotifier;
}

export function setChannelNotifierPort(notifier: ChannelNotifierPort | null): void {
  getRuntimeIntegrations().channelNotifier = notifier;
}

export function getChannelNotifierPort(): ChannelNotifierPort | null {
  return getRuntimeIntegrations().channelNotifier;
}

export function setNotificationDeliveryAdapterPort(
  adapter: NotificationDeliveryAdapterPort | null,
): void {
  getRuntimeIntegrations().notificationDeliveryAdapter = adapter;
}

export function getNotificationDeliveryAdapterPort(): NotificationDeliveryAdapterPort | null {
  return getRuntimeIntegrations().notificationDeliveryAdapter;
}

export function setAgentKillPort(fn: AgentKillPort | null): void {
  getRuntimeIntegrations().killFunction = fn;
}

export function getAgentKillPort(): AgentKillPort | null {
  return getRuntimeIntegrations().killFunction;
}

export function setDispatchInjectorPort(fn: DispatchInjectorPort | null): void {
  getRuntimeIntegrations().dispatchInjector = fn;
}

export function getDispatchInjectorPort(): DispatchInjectorPort | null {
  return getRuntimeIntegrations().dispatchInjector;
}

export function setCronServicePort(service: CronServicePort | null): void {
  getRuntimeIntegrations().cronService = service;
}

export function getCronServicePort(): CronServicePort | null {
  return getRuntimeIntegrations().cronService;
}

export function setDiagnosticEmitterPort(fn: DiagnosticEmitterPort | null): void {
  getRuntimeIntegrations().diagnosticEmitter = fn;
}

export function getDiagnosticEmitterPort(): DiagnosticEmitterPort | null {
  return getRuntimeIntegrations().diagnosticEmitter;
}

export function setSSEManagerPort(manager: SSEManagerPort | null): void {
  getRuntimeIntegrations().sseManager = manager;
}

export function getSSEManagerPort(): SSEManagerPort | null {
  return getRuntimeIntegrations().sseManager;
}

export function setOpenClawConfigSnapshot(snapshot: OpenClawConfigSnapshot | null): void {
  getRuntimeIntegrations().openClawConfigSnapshot = snapshot;
}

export function getOpenClawConfigSnapshot(): OpenClawConfigSnapshot | null {
  return getRuntimeIntegrations().openClawConfigSnapshot;
}

export function registerDispatchExecutorPort(executor: DispatchExecutorPort): void {
  getRuntimeIntegrations().dispatchExecutors.set(executor.id, executor);
}

export function unregisterDispatchExecutorPort(executorId: string): void {
  getRuntimeIntegrations().dispatchExecutors.delete(executorId);
}

export function getDispatchExecutorPort(executorId: string): DispatchExecutorPort | null {
  return getRuntimeIntegrations().dispatchExecutors.get(executorId) ?? null;
}

export function listDispatchExecutorPorts(): DispatchExecutorPort[] {
  return [...getRuntimeIntegrations().dispatchExecutors.values()];
}

export function resetDispatchExecutorPortsForTest(): void {
  getRuntimeIntegrations().dispatchExecutors.clear();
}

function getOpenClawState(): OpenClawSessionState {
  return runtime.openClaw;
}

export function isMemoryModeEnabled(sessionKey: string): boolean {
  return getOpenClawState().memoryModeBySession.get(sessionKey) ?? false;
}

export function toggleMemoryMode(sessionKey: string): boolean {
  const next = !isMemoryModeEnabled(sessionKey);
  getOpenClawState().memoryModeBySession.set(sessionKey, next);
  return next;
}

export function incrementOpenClawSessionTurnCount(sessionKey: string): number {
  const state = getOpenClawState();
  const next = (state.sessionTurnCounts.get(sessionKey) ?? 0) + 1;
  state.sessionTurnCounts.set(sessionKey, next);
  return next;
}

export function setOpenClawMeetingSession(
  sessionKey: string,
  meeting: OpenClawMeetingSession,
): void {
  getOpenClawState().meetingSessions.set(sessionKey, meeting);
}

export function takeOpenClawMeetingSession(
  sessionKey: string,
): OpenClawMeetingSession | null {
  const state = getOpenClawState();
  const meeting = state.meetingSessions.get(sessionKey) ?? null;
  if (meeting) {
    state.meetingSessions.delete(sessionKey);
  }
  return meeting;
}

export function clearOpenClawSessionState(sessionKey: string): void {
  const state = getOpenClawState();
  state.memoryModeBySession.delete(sessionKey);
  state.sessionTurnCounts.delete(sessionKey);
  state.meetingSessions.delete(sessionKey);
}

export function resetOpenClawSessionStateForTest(): void {
  const state = getOpenClawState();
  state.memoryModeBySession.clear();
  state.sessionTurnCounts.clear();
  state.meetingSessions.clear();
}
