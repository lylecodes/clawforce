/**
 * clawforce — Core library entry point
 *
 * Reliability and accountability engine for autonomous agents.
 * Framework-agnostic: use directly as a library, or through an adapter
 * (e.g. adapters/openclaw.ts for OpenClaw integration).
 */

// --- Lifecycle & Configuration ---
export { initClawforce, shutdownClawforce, getActiveProjectIds, registerProject, unregisterProject, isClawforceInitialized } from "./lifecycle.js";
export {
  getAgentConfig,
  initProject,
  loadWorkforceConfig,
  loadEnforcementConfig,
  loadProject,
  registerWorkforceConfig,
  registerEnforcementConfig,
  resolveProjectDir,
  getApprovalPolicy,
  getRegisteredAgentIds,
  getExtendedProjectConfig,
} from "./project.js";
export { validateWorkforceConfig, validateEnforcementConfig } from "./config-validator.js";
export { generateDefaultScopePolicies } from "./profiles.js";

// --- Enforcement ---
export { startTracking, recordToolCall, endSession, getSession, recoverOrphanedSessions } from "./enforcement/tracker.js";
export { checkCompliance } from "./enforcement/check.js";
export { executeFailureAction, executeCrashAction, recordCompliantRun } from "./enforcement/actions.js";
export { resolveEscalationTarget, routeEscalation } from "./enforcement/escalation-router.js";
export { disableAgent, enableAgent, isAgentDisabled } from "./enforcement/disabled-store.js";

// --- Context Assembly ---
export { assembleContext } from "./context/assembler.js";
export { buildOnboardingContext, buildExplainContent } from "./context/onboarding.js";
export { buildMemoryContext } from "./context/sources/memory.js";

// --- Skills ---
export { resolveSkillSource, getTopicList, SKILL_TOPICS } from "./skills/registry.js";

// --- Tools ---
export { adaptTool, jsonResult, errorResult, safeExecute } from "./tools/common.js";
export { createClawforceTaskTool } from "./tools/task-tool.js";
export { createClawforceLogTool } from "./tools/log-tool.js";
export { createClawforceSetupTool } from "./tools/setup-tool.js";
export { createClawforceVerifyTool } from "./tools/verify-tool.js";
export { createClawforceCompactTool } from "./tools/compact-tool.js";
export { createClawforceWorkflowTool } from "./tools/workflow-tool.js";
export { createClawforceOpsTool } from "./tools/ops-tool.js";
export { createClawforceMemoryTool } from "./tools/memory-tool.js";

// --- Policy ---
export { registerPolicies } from "./policy/registry.js";
export { withPolicyCheck } from "./policy/middleware.js";

// --- Approval ---
export { approveProposal, listPendingProposals, rejectProposal } from "./approval/resolve.js";

// --- Audit ---
export { registerKillFunction } from "./audit/auto-kill.js";

// --- Tasks ---
export { handleWorkerSessionEnd } from "./tasks/session-end.js";

// --- Diagnostics ---
export { emitDiagnosticEvent, setDiagnosticEmitter } from "./diagnostics.js";

// --- Database ---
export { getDb, getMemoryDb, closeDb, closeAllDbs, setProjectsDir, getProjectsDir, validateProjectId } from "./db.js";

// --- Types ---
export type {
  Task,
  TaskState,
  Evidence,
  EvidenceType,
  Transition,
  Workflow,
  WorkflowPhase,
  AgentConfig,
  AgentPermissions,
  AgentRole,
  ContextSource,
  Expectation,
  PerformancePolicy,
  WorkforceConfig,
  RequiredOutput,
  FailureAction,
  EnforcementProjectConfig,
  CostRecord,
  BudgetConfig,
  BudgetCheckResult,
  CronRegistrar,
  CronRegistrarInput,
  ClawforceEvent,
  DispatchQueueItem,
} from "./types.js";
