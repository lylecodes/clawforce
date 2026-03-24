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

// --- Config: OpenClaw Reader ---
export { setOpenClawConfig, getAgentModel, getAgentTools, getModelPricing, getProviderRateLimits, clearOpenClawConfigCache } from "./config/openclaw-reader.js";

// --- Config: Inference ---
export { inferPreset, markInferred, wasInferred, clearInferenceState } from "./config/inference.js";

// --- Config: Budget Guide ---
export { estimateBudget, formatBudgetSummary, MODEL_COSTS } from "./config/budget-guide.js";
export type { AgentBudgetInput, AgentCostEstimate, BudgetEstimate } from "./config/budget-guide.js";

// --- Config: Init Flow ---
export { getInitQuestions, buildConfigFromAnswers, getBudgetGuidance } from "./config/init-flow.js";
export type { QuestionType, InitQuestion, AgentAnswer, InitAnswers } from "./config/init-flow.js";

// --- Operational Profiles ---
export { expandProfile, normalizeDomainProfile } from "./profiles/operational.js";
export { estimateProfileCost, recommendProfile } from "./profiles/cost-preview.js";
export type { CostAgentInput } from "./profiles/cost-preview.js";
export { OPERATIONAL_PROFILES } from "./types.js";

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
export { startTracking, recordToolCall, recordToolCallDetail, endSession, getSession, recoverOrphanedSessions } from "./enforcement/tracker.js";
export { checkCompliance } from "./enforcement/check.js";
export { executeFailureAction, executeCrashAction, recordCompliantRun } from "./enforcement/actions.js";
export { resolveEscalationTarget, routeEscalation } from "./enforcement/escalation-router.js";
export { disableAgent, enableAgent, isAgentDisabled } from "./enforcement/disabled-store.js";

// --- Context Assembly ---
export { assembleContext } from "./context/assembler.js";
export { buildOnboardingContext, buildExplainContent } from "./context/onboarding.js";

// --- Jobs (Scoped Sessions) ---
export { resolveJobName, resolveEffectiveConfig, canManageJobs, listJobs, upsertJob, deleteJob } from "./jobs.js";

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

// --- Channel Delivery ---
export { setDeliveryAdapter, getDeliveryAdapter, deliverMessage, clearDeliveryAdapter } from "./channels/deliver.js";
export type { DeliveryAdapter, DeliveryRequest, DeliveryResult as ChannelDeliveryResult } from "./channels/deliver.js";

// --- Audit ---
export { registerKillFunction } from "./audit/auto-kill.js";

// --- Tasks ---
export { handleWorkerSessionEnd } from "./tasks/session-end.js";

// --- Memory Governance ---
export { resolveMemoryInstructions, MANAGER_MEMORY_INSTRUCTIONS, EMPLOYEE_MEMORY_INSTRUCTIONS } from "./context/sources/memory-instructions.js";
export { buildReviewContext } from "./memory/review-context.js";
export type { ReviewContextOpts } from "./memory/review-context.js";

// --- Memory (Ghost Turn + Flush) ---
export { runGhostRecall, runCronRecall, clearCooldown, clearAllCooldowns, INTENSITY_PRESETS } from "./memory/ghost-turn.js";
export type { GhostTurnIntensity, GhostTurnOpts, GhostRecallResult, MemoryToolInstance } from "./memory/ghost-turn.js";
export { resolveProvider, callTriage, parseTriageResponse } from "./memory/llm-client.js";
export type { ProviderInfo, TriageResult } from "./memory/llm-client.js";
export { isMemoryWriteCall, getFlushPrompt } from "./memory/flush-tracker.js";

// --- Event Actions & Templates ---
export { interpolate, interpolateRecord } from "./events/template.js";
export type { TemplateContext } from "./events/template.js";
export { executeAction } from "./events/actions.js";
export type { ActionResult } from "./events/actions.js";

// --- Triggers ---
export { evaluateConditions, resolvePath } from "./triggers/conditions.js";
export type { ConditionResult, ConditionsResult } from "./triggers/conditions.js";
export { fireTrigger, getTriggerDefinitions, clearCooldowns } from "./triggers/processor.js";
export type { TriggerFireResult } from "./triggers/processor.js";
export { normalizeTriggerConfig } from "./project.js";

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

// --- Budget v2 ---
export { normalizeBudgetConfig } from "./budget/normalize.js";
export { ensureWindowsCurrent, getNextHourBoundary, getNextMidnightUTC, getNextMonthBoundaryUTC } from "./budget/reset.js";
export { checkBudgetV2 } from "./budget/check-v2.js";
export { reserveBudget, settlePlanItem, releasePlanReservation, cleanupStaleReservations } from "./budget/reservation.js";
export { computeDailySnapshot, computeWeeklyTrend, computeMonthlyProjection } from "./budget/forecast.js";
export type { BudgetConfigV2, BudgetWindowConfig, DailyBudgetSnapshot, WeeklyTrend, MonthlyProjection } from "./types.js";
export type { BudgetAllocation } from "./budget-cascade.js";

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
export { parseFrequency, shouldRunNow } from "./scheduling/frequency.js";
export type { FrequencyTarget, ShouldRunResult } from "./scheduling/frequency.js";
export { checkFrequencyJobs } from "./scheduling/scheduler.js";
export type { FrequencyDispatch } from "./scheduling/scheduler.js";

// --- Knowledge Lifecycle ---
export { trackRetrieval, getRetrievalStats, getStatsAboveThreshold } from "./memory/retrieval-tracker.js";
export type { RetrievalStat } from "./memory/retrieval-tracker.js";
export { isDuplicateQuery, logSearchQuery } from "./memory/search-dedup.js";
export { checkPromotionCandidates, listCandidates, getCandidate, approveCandidate, dismissCandidate, suggestTarget } from "./memory/promotion.js";
export { createFlag, getFlag, listFlags, resolveFlag, dismissFlag } from "./memory/demotion.js";
export type { CreateFlagParams } from "./memory/demotion.js";
export { formatExpectationsReminder } from "./memory/ghost-turn.js";

// Adaptation
export { hireAgent } from "./adaptation/hire.js";
export type { HireSpec, HireResult } from "./adaptation/hire.js";
export { reallocateBudget } from "./adaptation/budget-reallocate.js";
export type { ReallocateParams, ReallocateResult } from "./adaptation/budget-reallocate.js";
export { checkAdaptationPermission, ADAPTATION_CARDS } from "./adaptation/cards.js";
export type { AdaptationCard, CardRisk, PermissionResult } from "./adaptation/cards.js";
export { initializeAutonomy } from "./adaptation/autonomy-init.js";

// Direction
export { parseDirection, validateDirection } from "./direction.js";
export type { Direction, DirectionPhase, DirectionConstraints, Autonomy } from "./direction.js";

// Templates
export { getTemplate, STARTUP_TEMPLATE } from "./templates/startup.js";
export type { TemplateDefinition } from "./templates/startup.js";

// Context: observed events
export { renderObservedEvents } from "./context/observed-events.js";

// --- Telemetry ---
export { archiveSession, getSessionArchive, listSessionArchives } from "./telemetry/session-archive.js";
export type { SessionArchive, SessionArchiveParams, SessionArchiveFilters } from "./telemetry/session-archive.js";
export { flushToolCallDetails, getToolCallDetails } from "./telemetry/tool-capture.js";
export type { ToolCallDetail, ToolCallDetailRow } from "./telemetry/tool-capture.js";
export { detectConfigChange, getConfigVersion, getConfigHistory } from "./telemetry/config-tracker.js";
export type { ConfigVersion } from "./telemetry/config-tracker.js";
export { recordReview, getReviewsForTask, getReviewStats } from "./telemetry/review-store.js";
export type { ReviewParams, ManagerReview, ReviewStats } from "./telemetry/review-store.js";
export { snapshotTrustScore, getTrustTimeline } from "./telemetry/trust-history.js";
export type { TrustSnapshotParams, TrustSnapshot } from "./telemetry/trust-history.js";

// --- Experiments ---
export { createExperiment, startExperiment, pauseExperiment, completeExperiment, killExperiment, getExperiment, listExperiments } from "./experiments/lifecycle.js";
export type { CreateExperimentParams } from "./experiments/lifecycle.js";
export { mergeVariantConfig } from "./experiments/config.js";
export { assignVariant, getActiveExperimentForProject } from "./experiments/assignment.js";
export type { AssignmentContext } from "./experiments/assignment.js";
export { recordExperimentOutcome, getExperimentResults } from "./experiments/results.js";
export type { VariantResult, ExperimentResults } from "./experiments/results.js";
export { checkCanaryHealth } from "./experiments/canary.js";
export type { CanaryAction } from "./experiments/canary.js";
export { validateExperimentConfig } from "./experiments/validation.js";
export type { ValidationError, ExperimentConfigInput } from "./experiments/validation.js";

// --- Verification Gates ---
export { runVerificationGates, formatGateResults } from "./verification/runner.js";
export type { GateResult, VerificationRunResult } from "./verification/runner.js";
export { generateBranchName, createTaskBranch, mergeTaskBranch, deleteTaskBranch, discardTaskBranch } from "./verification/git.js";
export { getEffectiveVerificationConfig, runVerificationIfConfigured } from "./verification/lifecycle.js";
export type { VerificationConfig, VerificationGate, GitIsolationConfig } from "./types.js";

// --- Dispatch Gate ---
export { shouldDispatch } from "./dispatch/dispatcher.js";
export { recoverProject, releaseStaleInProgressTasks, failStaleDispatchItems, releaseExpiredAssignedLeases } from "./dispatch/restart-recovery.js";

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
  MemoryGovernanceConfig,
  RuleDefinition,
  RuleTrigger,
  RuleAction,
  OperationalProfile,
  OperationalProfileConfig,
  CostBucket,
  CostLineItem,
  ProfileCostEstimate,
  ProfileRecommendation,
  TriggerSource,
  TriggerAuthType,
  TriggerAuth,
  TriggerCondition,
  TriggerConditionOperator,
  TriggerAfterProcess,
  TriggerSeverity,
  TriggerDefinition,
  ExperimentState,
  ExperimentAssignmentStrategy,
  CompletionCriteria,
  VariantConfig,
  ExperimentOutcome,
  Experiment,
  ExperimentVariant,
  ExperimentSession,
  LifecycleConfig,
  ManagerBehaviorConfig,
  TelemetryConfig,
  ContextOwnershipConfig,
} from "./types.js";
