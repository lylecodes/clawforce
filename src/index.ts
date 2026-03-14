/**
 * clawforce — Core library entry point
 *
 * Reliability and accountability engine for autonomous agents.
 * Framework-agnostic: use directly as a library, or through an adapter
 * (e.g. adapters/openclaw.ts for OpenClaw integration).
 */

// --- Lifecycle & Configuration ---
export { initClawforce, shutdownClawforce, getActiveProjectIds, registerProject, unregisterProject, isClawforceInitialized, registerDomain, unregisterDomain, getActiveDomainIds } from "./lifecycle.js";
export { syncAgentsToOpenClaw, buildOpenClawAgentEntry } from "./agent-sync.js";
export {
  getAgentConfig,
  initProject,
  registerWorkforceConfig,
  resolveProjectDir,
  getApprovalPolicy,
  getRegisteredAgentIds,
  getExtendedProjectConfig,
} from "./project.js";
export { validateWorkforceConfig, validateEnforcementConfig, validateDomainQuality } from "./config-validator.js";

// --- Config System ---
export { loadGlobalConfig, loadAllDomains, resolveDomainFromPath, validateDomainAgents } from "./config/loader.js";
export { validateGlobalConfig, validateDomainConfig, validateRuleDefinition } from "./config/schema.js";
export type { GlobalConfig, DomainConfig, GlobalAgentDef, GlobalDefaults, ValidationResult } from "./config/schema.js";
export { registerGlobalAgents, assignAgentsToDomain, getGlobalAgent, getAgentDomain, getAgentDomains, getDomainAgents, getGlobalAgentIds, clearRegistry } from "./config/registry.js";
export { initializeAllDomains } from "./config/init.js";
export type { InitResult } from "./config/init.js";
export { scaffoldConfigDir, initDomain } from "./config/wizard.js";
export type { InitDomainOpts } from "./config/wizard.js";
export { startConfigWatcher, stopConfigWatcher, diffConfigs, diffDomainConfigs } from "./config/watcher.js";
export type { GlobalConfigDiff, DomainConfigDiff, ReloadCallback } from "./config/watcher.js";

// --- Config: Inference ---
export { inferPreset, markInferred, wasInferred, clearInferenceState } from "./config/inference.js";

// --- Config: Budget Guide ---
export { estimateBudget, formatBudgetSummary, MODEL_COSTS } from "./config/budget-guide.js";
export type { AgentBudgetInput, AgentCostEstimate, BudgetEstimate } from "./config/budget-guide.js";

// --- Config: Init Flow ---
export { getInitQuestions, buildConfigFromAnswers, getBudgetGuidance } from "./config/init-flow.js";
export type { QuestionType, InitQuestion, AgentAnswer, InitAnswers } from "./config/init-flow.js";

// --- Rules ---
export { matchRules, buildPromptFromRule, evaluateRules } from "./rules/engine.js";
export type { RuleEvent, MatchedRule } from "./rules/engine.js";
export { formatEvolutionPrompt } from "./rules/evolution.js";

// --- Streams ---
export { registerStream, getStream, listStreams, clearCatalog, formatStreamCatalog } from "./streams/catalog.js";
export type { OutputTarget, ParamSchema, StreamDefinition } from "./streams/catalog.js";
export { registerBuiltinStreams } from "./streams/builtin-manifest.js";
export { validateStreamParams } from "./streams/params.js";
export type { ParamValidationResult } from "./streams/params.js";
export { executeCustomStream } from "./streams/custom.js";
export type { CustomStreamDef, StreamResult } from "./streams/custom.js";
export { evaluateCondition } from "./streams/conditions.js";
export { evaluateRoute, executeRoute, deliverToOutput } from "./streams/router.js";
export type { RouteOutput, RouteDefinition, RouteEvalResult, DeliveryResult } from "./streams/router.js";

// --- Onboarding Sources ---
export { resolveBudgetGuidanceSource } from "./context/sources/budget-guidance.js";
export { resolveWelcomeSource, resolveWeeklyDigestSource, resolveInterventionSource } from "./context/sources/onboarding-sources.js";

export { generateDefaultScopePolicies } from "./profiles.js";
export { resolveConfig, mergeArrayWithOperators, detectCycle, BUILTIN_AGENT_PRESETS, BUILTIN_JOB_PRESETS } from "./presets.js";

// --- Enforcement ---
export { startTracking, recordToolCall, endSession, getSession, recoverOrphanedSessions } from "./enforcement/tracker.js";
export { checkCompliance } from "./enforcement/check.js";
export { executeFailureAction, executeCrashAction, recordCompliantRun } from "./enforcement/actions.js";
export { resolveEscalationTarget, routeEscalation } from "./enforcement/escalation-router.js";
export { disableAgent, enableAgent, isAgentDisabled } from "./enforcement/disabled-store.js";

// --- Context Assembly ---
export { assembleContext } from "./context/assembler.js";
export { buildOnboardingContext, buildExplainContent } from "./context/onboarding.js";

// --- Jobs (Scoped Sessions) ---
export { resolveJobName, resolveEffectiveConfig, canManageJobs, listJobs, upsertJob, deleteJob } from "./jobs.js";
export { setCronService, getCronService } from "./manager-cron.js";
export type { CronServiceLike } from "./manager-cron.js";

// --- Skills ---
export { resolveSkillSource, getTopicList, registerCustomSkills, SKILL_TOPICS } from "./skills/registry.js";

// --- Tools ---
export { adaptTool, jsonResult, errorResult, safeExecute } from "./tools/common.js";
export { createClawforceTaskTool } from "./tools/task-tool.js";
export { createClawforceLogTool } from "./tools/log-tool.js";
export { createClawforceSetupTool } from "./tools/setup-tool.js";
export { createClawforceVerifyTool } from "./tools/verify-tool.js";
export { createClawforceCompactTool } from "./tools/compact-tool.js";
export { createClawforceWorkflowTool } from "./tools/workflow-tool.js";
export { createClawforceOpsTool } from "./tools/ops-tool.js";
export { createClawforceContextTool } from "./tools/context-tool.js";
export { createClawforceMessageTool } from "./tools/message-tool.js";
export { createClawforceGoalTool } from "./tools/goal-tool.js";
export { createClawforceChannelTool } from "./tools/channel-tool.js";


// --- Policy ---
export { registerPolicies } from "./policy/registry.js";
export { withPolicyCheck } from "./policy/middleware.js";

// --- Approval ---
export { approveProposal, listPendingProposals, rejectProposal } from "./approval/resolve.js";
export { resolveApprovalChannel } from "./approval/channel-router.js";
export type { ApprovalChannel, ChannelConfig } from "./approval/channel-router.js";
export { setApprovalNotifier, getApprovalNotifier, formatTelegramMessage, buildApprovalButtons } from "./approval/notify.js";
export type { ApprovalNotifier, NotificationPayload, NotificationResult } from "./approval/notify.js";
export { persistToolCallIntent, getIntentByProposalForProject, getApprovedIntentsForTask, resolveIntentForProject } from "./approval/intent-store.js";
export type { ToolCallIntent } from "./approval/intent-store.js";
export { addPreApproval, checkPreApproval, consumePreApproval } from "./approval/pre-approved.js";

// --- Messaging ---
export { createMessage, getMessage, getPendingMessages, listMessages, listSentMessages, markDelivered, markBulkDelivered, markRead, getThread, searchMessages, updateProtocolStatus } from "./messaging/store.js";
export { setMessageNotifier, getMessageNotifier, formatMessageNotification, notifyMessage } from "./messaging/notify.js";
export type { MessageNotifier } from "./messaging/notify.js";
export {
  initiateRequest, initiateDelegation, initiateFeedback,
  respondToRequest, acceptDelegation, rejectDelegation, completeDelegation, submitFeedback,
  getActiveProtocols, getExpiredProtocols, expireProtocol, escalateProtocol, validateProtocolTransition,
} from "./messaging/protocols.js";

// --- Goals ---
export { createGoal, getGoal, listGoals, updateGoal, achieveGoal, abandonGoal, getChildGoals, getGoalTree, linkTaskToGoal, unlinkTaskFromGoal, getGoalTasks, findRootInitiative, getInitiativeSpend } from "./goals/ops.js";
export type { CreateGoalParams, ListGoalsFilters, GoalTreeNode } from "./goals/ops.js";
export { checkGoalCascade, computeGoalProgress } from "./goals/cascade.js";
export type { GoalProgress, CascadeResult } from "./goals/cascade.js";

// --- Channels ---
export { createChannel, getChannel, getChannelByName, listChannels, addMember, removeMember, updateChannelMetadata, concludeChannel, archiveChannel, getChannelMessages } from "./channels/store.js";
export { sendChannelMessage, buildChannelTranscript } from "./channels/messages.js";
export { startMeeting, advanceMeetingTurn, concludeMeeting, getMeetingStatus } from "./channels/meeting.js";
export { setChannelNotifier, getChannelNotifier, notifyChannelMessage } from "./channels/notify.js";

// --- Audit ---
export { registerKillFunction } from "./audit/auto-kill.js";

// --- Tasks ---
export { handleWorkerSessionEnd } from "./tasks/session-end.js";

// --- Memory (Ghost Turn + Flush) ---
export { runGhostRecall, runCronRecall, clearCooldown, clearAllCooldowns, INTENSITY_PRESETS } from "./memory/ghost-turn.js";
export type { GhostTurnIntensity, GhostTurnOpts, MemoryToolInstance } from "./memory/ghost-turn.js";
export { resolveProvider, callTriage, parseTriageResponse } from "./memory/llm-client.js";
export type { ProviderInfo, TriageResult } from "./memory/llm-client.js";
export {
  incrementTurnCount, incrementToolCallCount, markMemoryWrite, hasMemoryWrite,
  shouldFlush, resetCycle, markFlushAttempted, hasFlushBeenAttempted,
  isSessionSubstantive, clearSession as clearFlushSession, isMemoryWriteCall,
  getFlushPrompt,
} from "./memory/flush-tracker.js";

// --- Event Actions & Templates ---
export { interpolate, interpolateRecord } from "./events/template.js";
export type { TemplateContext } from "./events/template.js";
export { executeAction } from "./events/actions.js";
export type { ActionResult } from "./events/actions.js";

// --- Diagnostics ---
export { emitDiagnosticEvent, setDiagnosticEmitter } from "./diagnostics.js";

// --- Pricing ---
export { getPricing, registerModelPricing, registerModelPricingFromConfig, registerBulkPricing } from "./pricing.js";
export type { ModelPricing } from "./pricing.js";

// --- Rate Limits ---
export { updateProviderUsage, getProviderUsage, getAllProviderUsage, isProviderThrottled, getMaxUsagePercent } from "./rate-limits.js";
export type { ProviderUsage, UsageWindow } from "./rate-limits.js";

// --- Cascading Budget ---
export { allocateBudget, getAgentBudgetStatus } from "./budget-cascade.js";
export type { AllocateBudgetParams, AllocateBudgetResult, AgentBudgetStatus } from "./budget-cascade.js";

// --- Multi-Window Budget ---
export { getBudgetStatus, checkMultiWindowBudget } from "./budget-windows.js";
export type { BudgetStatus, WindowStatus } from "./budget-windows.js";

// --- Capacity ---
export { getCapacityReport } from "./capacity.js";
export type { CapacityReport, ThrottleRisk } from "./capacity.js";

// --- Resources Context ---
export { buildResourcesContext } from "./context/sources/resources.js";

// --- Budget Parser ---
export { parseBudgetShorthand } from "./budget-parser.js";

// --- Cost Auto-Capture ---
export { recordCostFromLlmOutput } from "./cost.js";

// --- Scheduling ---
export { getCostEstimate } from "./scheduling/cost-engine.js";
export type { CostEstimate } from "./scheduling/cost-engine.js";
export { createPlan, getPlan, startPlan, completePlan, abandonPlan, listPlans } from "./scheduling/plans.js";
export type { CreatePlanParams, CompletePlanParams } from "./scheduling/plans.js";
export { computeAvailableSlots } from "./scheduling/slots.js";
export type { SlotAvailability, SlotCalcInput, ModelConfig } from "./scheduling/slots.js";
export { clampCronToWakeBounds } from "./scheduling/wake-bounds.js";

// --- Knowledge Lifecycle ---
export { trackRetrieval, getRetrievalStats, getStatsAboveThreshold } from "./memory/retrieval-tracker.js";
export type { RetrievalStat } from "./memory/retrieval-tracker.js";
export { isDuplicateQuery, logSearchQuery } from "./memory/search-dedup.js";
export { checkPromotionCandidates, listCandidates, getCandidate, approveCandidate, dismissCandidate, suggestTarget } from "./memory/promotion.js";
export { createFlag, getFlag, listFlags, resolveFlag, dismissFlag } from "./memory/demotion.js";
export type { CreateFlagParams } from "./memory/demotion.js";
export { formatExpectationsReminder } from "./memory/ghost-turn.js";

// --- Dispatch Gate ---
export { shouldDispatch } from "./dispatch/dispatcher.js";

// --- Dashboard ---
export { createDashboardServer, handleRequest } from "./dashboard/index.js";
export type { DashboardOptions } from "./dashboard/index.js";

// --- Database ---
export { getDb, getMemoryDb, closeDb, closeAllDbs, setProjectsDir, getProjectsDir, validateProjectId, getDbByDomain, setDataDir, getDataDir } from "./db.js";

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
  CoordinationConfig,
  ContextSource,
  Expectation,
  JobDefinition,
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
  ActionConstraint,
  ActionConstraints,
  ActionScope,
  DispatchQueueItem,
  SkillPack,
  Message,
  MessageType,
  MessagePriority,
  MessageStatus,
  ProtocolStatus,
  Goal,
  GoalStatus,
  EventActionConfig,
  EventHandlerConfig,
  EventActionType,
  Channel,
  ChannelType,
  ChannelStatus,
  ChannelConfig as CommChannelConfig,
  MeetingConfig,
  PromotionTarget,
  PromotionCandidate,
  KnowledgeFlag,
  KnowledgeConfig,
  RuleDefinition,
  RuleTrigger,
  RuleAction,
} from "./types.js";
