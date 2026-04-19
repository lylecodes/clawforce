/**
 * clawforce/advanced — Supported lower-level contracts
 *
 * This surface is intentionally narrower than `clawforce/internal`.
 * It is for builders who need extension and integration primitives without
 * depending on the full unstable internal barrel.
 */

// --- Canonical Config Document / Patch APIs ---
export {
  applyPlannedConfigChange,
  loadDomainConfigDocument,
  loadGlobalConfigDocument,
  planConfigDocumentPatch,
  planDomainConfigMerge,
  planDomainConfigPatch,
  planDomainConfigSectionReplace,
  planGlobalConfigMerge,
  planGlobalConfigPatch,
  planGlobalConfigSectionReplace,
  summarizeTopLevelChangedKeys,
} from "./config/document.js";
export type {
  ConfigDocument,
  ConfigDocumentScope,
  ConfigPlanningResult,
  PlannedConfigChange,
} from "./config/document.js";
export {
  applyConfigPatch,
  createMergeConfigPatch,
  createSectionReplacePatch,
  deepMerge,
  previewDomainConfigPatch,
  previewGlobalConfigPatch,
} from "./config/patch.js";
export type {
  ConfigPatch,
  ConfigPatchOperation,
  ConfigPatchPath,
  ConfigPatchPreview,
} from "./config/patch.js";

// --- Dashboard Extension Contracts ---
export {
  clearDashboardExtensions,
  getDashboardExtension,
  listDashboardExtensions,
  registerDashboardExtension,
  unregisterDashboardExtension,
} from "./dashboard/extensions.js";
export type {
  DashboardExtensionAction,
  DashboardExtensionConfigSection,
  DashboardExtensionContribution,
  DashboardExtensionPage,
  DashboardExtensionPanel,
  DashboardExtensionSource,
  DashboardExtensionSurface,
} from "./dashboard/extensions.js";

// --- Runtime Ports ---
export type {
  AgentKillPort,
  ApprovalNotificationPayloadPort,
  ApprovalNotificationResultPort,
  ApprovalNotifierPort,
  ChannelNotifierPort,
  ChannelPort,
  CronJobRecordPort,
  CronJobStatePort,
  CronServicePort,
  DeliveryAdapterPort,
  DiagnosticEmitterPort,
  DiagnosticPayloadPort,
  DispatchInjectorPort,
  MessageNotifierPort,
  MessagePort,
  NotificationDeliveryAdapterPort,
  NotificationRecordPort,
  OpenClawAgentEntry,
  OpenClawConfigSnapshot,
  OpenClawMeetingSession,
  OpenClawModelEntry,
  OpenClawProviderEntry,
  OpenClawSessionState,
  RuntimeIntegrationState,
  SSEManagerPort,
} from "./runtime/ports.js";

// --- Session Key Helpers ---
export {
  extractAgentIdFromReference,
  parseAgentSessionKey,
} from "./session-keys.js";
export type { ParsedAgentSessionKey } from "./session-keys.js";
