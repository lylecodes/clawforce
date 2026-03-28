# API Reference

Generated from `src/index.ts` exports and declaration files in `dist/src`.

## Lifecycle & Configuration

### `./lifecycle.js`

- **`initClawforce`**
  - Signature: `function initClawforce(config: ClawforceConfig): void`
- **`shutdownClawforce`**
  - Signature: `function shutdownClawforce(): Promise<void>`
- **`getActiveProjectIds`**
  - Signature: `function getActiveProjectIds(): string[]`
- **`registerProject`**
  - Signature: `function registerProject(projectId: string): void`
- **`unregisterProject`**
  - Signature: `function unregisterProject(projectId: string): void`
- **`isClawforceInitialized`**
  - Signature: `function isClawforceInitialized(): boolean`
- **`registerDomain`**
  - Signature: `function registerDomain(domainId: string): void`
- **`unregisterDomain`**
  - Signature: `function unregisterDomain(domainId: string): void`
- **`getActiveDomainIds`**
  - Signature: `function getActiveDomainIds(): string[]`

### `./agent-sync.js`

- **`syncAgentsToOpenClaw`**
  - Description: Sync clawforce agents into OpenClaw's config.agents.list[]. - Reads current config via loadConfig() - For each agent: builds entry, merges with existing (if any) - Writes config only if something changed (batched single write) - Per-agent errors are isolated; one failure doesn't block others
  - Signature: `function syncAgentsToOpenClaw(params: SyncParams): Promise<SyncResult>`
- **`buildOpenClawAgentEntry`**
  - Description: Map a clawforce agent config to an OpenClaw agent entry. Only maps fields that have a clear OpenClaw equivalent. Clawforce-internal fields (persona, department, expectations, etc.) are not mapped.
  - Signature: `function buildOpenClawAgentEntry(agentId: string, config: ClawforceAgentConfig, projectDir?: string): OpenClawAgentEntry`

### `./config-validator.js`

- **`validateWorkforceConfig`**
  - Description: Validate a workforce project config. Returns a list of warnings/errors. Empty list = valid.
  - Signature: `function validateWorkforceConfig(config: WorkforceConfig): ConfigWarning[]`
- **`validateEnforcementConfig`**
  - Signature: `const validateEnforcementConfig: (config: WorkforceConfig) => ConfigWarning[]`
- **`validateDomainQuality`**
  - Description: Validate domain config quality — returns non-blocking suggestions.
  - Signature: `function validateDomainQuality(domain: DomainConfig): ConfigWarning[]`

## Config System

### `./config/loader.js`

- **`loadGlobalConfig`**
  - Description: Load the global config from `{baseDir}/config.yaml`. Returns a default empty config if the file does not exist. Throws if the file exists but contains invalid YAML or fails validation.
  - Signature: `function loadGlobalConfig(baseDir: string): GlobalConfig`
- **`loadAllDomains`**
  - Description: Load all domain config files from `{baseDir}/domains/*.yaml`. Returns an empty array if the domains directory does not exist. Skips individual files that fail parsing or validation (logs a warning).
  - Signature: `function loadAllDomains(baseDir: string): DomainConfig[]`
- **`resolveDomainFromPath`**
  - Description: Resolve a working directory to a domain name by matching against each domain's `paths` array. Tilde (~) is expanded to the user's home directory. Longer path prefixes are checked first for specificity.
  - Signature: `function resolveDomainFromPath(workingDir: string, domains: DomainConfig[]): string | null`
- **`validateDomainAgents`**
  - Description: Validate that every agent referenced in a domain config is defined in the global config. Returns an array of warning strings for any agents that are missing.
  - Signature: `function validateDomainAgents(global: GlobalConfig, domain: DomainConfig): string[]`

### `./config/schema.js`

- **`validateGlobalConfig`**
  - Signature: `function validateGlobalConfig(config: unknown): ValidationResult`
- **`validateDomainConfig`**
  - Signature: `function validateDomainConfig(config: unknown): ValidationResult`
- **`validateRuleDefinition`**
  - Signature: `function validateRuleDefinition(rule: unknown): ValidationResult`

### `./config/schema.js`

- **`GlobalConfig`**
  - Signature: `type GlobalConfig = GlobalConfig`
- **`DomainConfig`**
  - Signature: `type DomainConfig = DomainConfig`
- **`GlobalAgentDef`**
  - Signature: `type GlobalAgentDef = GlobalAgentDef`
- **`GlobalDefaults`**
  - Signature: `type GlobalDefaults = GlobalDefaults`
- **`ValidationResult`**
  - Signature: `type ValidationResult = ValidationResult`

### `./config/registry.js`

- **`registerGlobalAgents`**
  - Signature: `function registerGlobalAgents(agents: Record<string, GlobalAgentDef>): void`
- **`assignAgentsToDomain`**
  - Signature: `function assignAgentsToDomain(domainId: string, agentIds: string[]): void`
- **`getGlobalAgent`**
  - Signature: `function getGlobalAgent(agentId: string): GlobalAgentDef | null`
- **`getAgentDomain`**
  - Description: Returns the primary (first-assigned) domain for an agent, or null.
  - Signature: `function getAgentDomain(agentId: string): string | null`
- **`getAgentDomains`**
  - Description: Returns all domains an agent is assigned to.
  - Signature: `function getAgentDomains(agentId: string): string[]`
- **`getDomainAgents`**
  - Description: Returns all agents assigned to a domain with their global config.
  - Signature: `function getDomainAgents(domainId: string): Array<{ id: string; config: GlobalAgentDef; }>`
- **`getGlobalAgentIds`**
  - Description: Returns all registered global agent IDs.
  - Signature: `function getGlobalAgentIds(): string[]`
- **`clearRegistry`**
  - Description: Clear all registries (for test cleanup).
  - Signature: `function clearRegistry(): void`

### `./config/init.js`

- **`initializeAllDomains`**
  - Description: Initialize all domains from the config directory. 1. Loads global config (agent roster + defaults) 2. Loads all domain configs 3. For each domain: registers agents, builds WorkforceConfig, bridges to existing system
  - Signature: `function initializeAllDomains(baseDir: string): InitResult`

### `./config/init.js`

- **`InitResult`**
  - Signature: `type InitResult = InitResult`

### `./config/wizard.js`

- **`scaffoldConfigDir`**
  - Description: Scaffold the base Clawforce config directory structure. Creates config.yaml (with empty agents if missing), domains/, and data/ directories. Idempotent — won't overwrite existing config.yaml.
  - Signature: `function scaffoldConfigDir(baseDir: string): void`
- **`initDomain`**
  - Description: Create a new domain config file. Also adds any new agents (from agentPresets) to the global config. Throws if domain already exists.
  - Signature: `function initDomain(baseDir: string, opts: InitDomainOpts): void`

### `./config/wizard.js`

- **`InitDomainOpts`**
  - Description: Clawforce — Init Wizard Programmatic API for scaffolding config directories and creating domains. CLI wrapper provides interactive prompts; agents call these functions directly.
  - Signature: `type InitDomainOpts = InitDomainOpts`

### `./config/watcher.js`

- **`startConfigWatcher`**
  - Description: Start watching config directory for changes. Debounces 500ms. Validates before applying.
  - Signature: `function startConfigWatcher(baseDir: string, onReload: ReloadCallback): void`
- **`stopConfigWatcher`**
  - Description: Stop all config file watchers.
  - Signature: `function stopConfigWatcher(): void`
- **`diffConfigs`**
  - Description: Compare two global configs and return what changed.
  - Signature: `function diffConfigs(oldConfig: GlobalConfig, newConfig: GlobalConfig): GlobalConfigDiff`
- **`diffDomainConfigs`**
  - Description: Compare two domain configs and return what changed.
  - Signature: `function diffDomainConfigs(oldDomain: DomainConfig, newDomain: DomainConfig): DomainConfigDiff`

### `./config/validate.js`

- **`validateAllConfigs`**
  - Description: Validate all config files in a project directory. Returns a report with all issues found.
  - Signature: `function validateAllConfigs(baseDir: string): ValidationReport`

### `./config/validate.js`

- **`ValidationReport`**
  - Signature: `type ValidationReport = ValidationReport`
- **`ValidationIssue`**
  - Signature: `type ValidationIssue = ValidationIssue`
- **`ValidationSeverity`**
  - Description: Clawforce — Config validation module Validates all config at load time, reporting ALL issues at once. Catches YAML errors, schema violations, and semantic conflicts between presets, agent config, and domain defaults.
  - Signature: `type ValidationSeverity = ValidationSeverity`

### `./config/watcher.js`

- **`GlobalConfigDiff`**
  - Signature: `type GlobalConfigDiff = GlobalConfigDiff`
- **`DomainConfigDiff`**
  - Signature: `type DomainConfigDiff = DomainConfigDiff`
- **`ReloadCallback`**
  - Signature: `type ReloadCallback = ReloadCallback`

## Config: OpenClaw Reader

### `./config/openclaw-reader.js`

- **`setOpenClawConfig`**
  - Description: Set the cached config (called at gateway_start or on config reload).
  - Signature: `function setOpenClawConfig(config: OpenClawConfigSnapshot): void`
- **`getAgentModel`**
  - Description: Get the model for an agent. Falls back to agent defaults.
  - Signature: `function getAgentModel(agentId: string): string | null`
- **`getAgentTools`**
  - Description: Get the tools list for an agent.
  - Signature: `function getAgentTools(agentId: string): string[] | null`
- **`getModelPricing`**
  - Description: Get pricing for a model (cents per 1M tokens).
  - Signature: `function getModelPricing(modelId: string): { inputPer1M: number; outputPer1M: number; } | null`
- **`getProviderRateLimits`**
  - Description: Get rate limits for a provider.
  - Signature: `function getProviderRateLimits(providerId: string): { rpm: number; tpm: number; } | null`
- **`clearOpenClawConfigCache`**
  - Description: Clear the cache (for testing or forced refresh).
  - Signature: `function clearOpenClawConfigCache(): void`

## Config: Inference

### `./config/inference.js`

- **`inferPreset`**
  - Signature: `function inferPreset(agentId: string, allAgents: Record<string, GlobalAgentDef>): "manager" | "employee"`
- **`markInferred`**
  - Signature: `function markInferred(agentId: string): void`
- **`wasInferred`**
  - Signature: `function wasInferred(agentId: string): boolean`
- **`clearInferenceState`**
  - Signature: `function clearInferenceState(): void`

## Config: Budget Guide

### `./config/budget-guide.js`

- **`estimateBudget`**
  - Signature: `function estimateBudget(agents: AgentBudgetInput[], modelCostOverrides?: Record<string, number>): BudgetEstimate`
- **`formatBudgetSummary`**
  - Signature: `function formatBudgetSummary(estimate: BudgetEstimate): string`
- **`MODEL_COSTS`**
  - Description: Default cost per session in cents, keyed by model identifier.
  - Signature: `const MODEL_COSTS: Record<string, number>`

### `./config/budget-guide.js`

- **`AgentBudgetInput`**
  - Description: Clawforce — Budget Guidance Estimates daily budget based on team composition and model costs. Provides per-agent cost breakdowns for init wizard and runtime guidance.
  - Signature: `type AgentBudgetInput = AgentBudgetInput`
- **`AgentCostEstimate`**
  - Signature: `type AgentCostEstimate = AgentCostEstimate`
- **`BudgetEstimate`**
  - Signature: `type BudgetEstimate = BudgetEstimate`

## Config: Init Flow

### `./config/init-flow.js`

- **`getInitQuestions`**
  - Signature: `function getInitQuestions(): InitQuestion[]`
- **`buildConfigFromAnswers`**
  - Signature: `function buildConfigFromAnswers(answers: InitAnswers): { global: Partial<GlobalConfig>; domain: InitDomainOpts; direction?: Partial<Direction>; }`
- **`getBudgetGuidance`**
  - Signature: `function getBudgetGuidance(answers: Partial<InitAnswers>): string | null`

### `./config/init-flow.js`

- **`QuestionType`**
  - Signature: `type QuestionType = QuestionType`
- **`InitQuestion`**
  - Signature: `type InitQuestion = InitQuestion`
- **`AgentAnswer`**
  - Signature: `type AgentAnswer = AgentAnswer`
- **`InitAnswers`**
  - Signature: `type InitAnswers = InitAnswers`

## Operational Profiles

### `./profiles/operational.js`

- **`expandProfile`**
  - Description: Expand a profile name to the full OperationalProfileConfig. Pure function, no side effects.
  - Signature: `function expandProfile(profile: OperationalProfile): OperationalProfileConfig`
- **`normalizeDomainProfile`**
  - Description: Pure config transformation: if domain has operational_profile, expand it into agent config overrides (jobs, scheduling, memory). Does NOT register cron jobs — that happens downstream in the adapter layer. Respects per-agent overrides: existing jobs/settings are not overwritten.
  - Signature: `function normalizeDomainProfile(domain: DomainConfig, global: GlobalConfig): DomainConfig`

### `./profiles/cost-preview.js`

- **`estimateProfileCost`**
  - Description: Estimate daily operational cost for a profile + agent composition. Returns a three-bucket cost breakdown.
  - Signature: `function estimateProfileCost(profile: OperationalProfile, agents: CostAgentInput[], budgetCents?: number): ProfileCostEstimate`
- **`recommendProfile`**
  - Description: Recommend the best operational profile for a team and budget. Logic: 1. Estimate cost for each profile level 2. Filter to profiles that fit within budget (with at least 30% headroom) 3. Pick the highest profile that fits 4. If none fit: recommend Low with a warning
  - Signature: `function recommendProfile(teamSize: number, budgetCents: number, agentRoles?: CostAgentInput[]): ProfileRecommendation`

### `./profiles/cost-preview.js`

- **`CostAgentInput`**
  - Signature: `type CostAgentInput = CostAgentInput`

### `./types.js`

- **`OPERATIONAL_PROFILES`**
  - Signature: `const OPERATIONAL_PROFILES: readonly OperationalProfile[]`

## Rules

### `./rules/engine.js`

- **`matchRules`**
  - Description: Match rules against an event. Returns all matching rules. Skips disabled rules (enabled === false).
  - Signature: `function matchRules(rules: RuleDefinition[], event: RuleEvent): RuleDefinition[]`
- **`buildPromptFromRule`**
  - Description: Build a prompt from a rule's template, interpolating {{dotted.path}} variables with values from the event data. Unmatched variables are left as-is (not replaced with empty string).
  - Signature: `function buildPromptFromRule(rule: RuleDefinition, eventData: Record<string, unknown>): string`
- **`evaluateRules`**
  - Description: Match rules and build prompts for all matches. Convenience function combining matchRules + buildPromptFromRule.
  - Signature: `function evaluateRules(rules: RuleDefinition[], event: RuleEvent): MatchedRule[]`

### `./rules/engine.js`

- **`RuleEvent`**
  - Signature: `type RuleEvent = RuleEvent`
- **`MatchedRule`**
  - Signature: `type MatchedRule = MatchedRule`

### `./rules/evolution.js`

- **`formatEvolutionPrompt`**
  - Description: Format the evolution prompt for orchestrator agents. This gets injected into ghost turns alongside expectations reminders.
  - Signature: `function formatEvolutionPrompt(): string`

## Streams

### `./streams/catalog.js`

- **`registerStream`**
  - Signature: `function registerStream(def: StreamDefinition): void`
- **`getStream`**
  - Signature: `function getStream(name: string): StreamDefinition | undefined`
- **`listStreams`**
  - Signature: `function listStreams(): StreamDefinition[]`
- **`clearCatalog`**
  - Signature: `function clearCatalog(): void`
- **`formatStreamCatalog`**
  - Signature: `function formatStreamCatalog(): string`

### `./streams/catalog.js`

- **`OutputTarget`**
  - Description: Clawforce — Stream Catalog Registry for all data streams (built-in context sources and user-defined custom streams). Provides discoverability via listStreams() and parameter schema for validation.
  - Signature: `type OutputTarget = OutputTarget`
- **`ParamSchema`**
  - Signature: `type ParamSchema = ParamSchema`
- **`StreamDefinition`**
  - Signature: `type StreamDefinition = StreamDefinition`

### `./streams/builtin-manifest.js`

- **`registerBuiltinStreams`**
  - Description: Clawforce — Built-in Stream Manifest Registers all existing context sources in the stream catalog. Resolution logic stays in the assembler; this provides metadata only.
  - Signature: `function registerBuiltinStreams(): void`

### `./streams/params.js`

- **`validateStreamParams`**
  - Signature: `function validateStreamParams(streamName: string, params: Record<string, unknown>): ParamValidationResult`

### `./streams/params.js`

- **`ParamValidationResult`**
  - Description: Clawforce — Stream Parameter Validation Validates user-supplied params against a stream's parameter schema.
  - Signature: `type ParamValidationResult = ParamValidationResult`

### `./streams/custom.js`

- **`executeCustomStream`**
  - Signature: `function executeCustomStream(dbPath: string, streamDef: CustomStreamDef, params?: Record<string, unknown>): StreamResult`

### `./streams/custom.js`

- **`CustomStreamDef`**
  - Description: Clawforce — Custom Computed Streams Executes user-defined SQL queries against a read-only DB connection. Results formatted as table, JSON, or summary for briefing/webhook use.
  - Signature: `type CustomStreamDef = CustomStreamDef`
- **`StreamResult`**
  - Signature: `type StreamResult = StreamResult`

### `./streams/conditions.js`

- **`evaluateCondition`**
  - Description: Clawforce — Safe Condition Evaluation Uses filtrex for safe expression evaluation with a strict whitelist. No access to globals, prototypes, or arbitrary code execution.
  - Signature: `function evaluateCondition(expression: string, context: Record<string, unknown>): boolean`

### `./streams/router.js`

- **`evaluateRoute`**
  - Signature: `function evaluateRoute(route: RouteDefinition, streamData: Record<string, unknown>): RouteEvalResult`
- **`executeRoute`**
  - Signature: `function executeRoute(route: RouteDefinition, streamData: Record<string, unknown>, content: string, projectId: string): Promise<{ route: string; results: DeliveryResult[]; }>`
- **`deliverToOutput`**
  - Signature: `function deliverToOutput(output: RouteOutput, routeName: string, content: string, projectId: string): Promise<DeliveryResult>`

### `./streams/router.js`

- **`RouteOutput`**
  - Signature: `type RouteOutput = RouteOutput`
- **`RouteDefinition`**
  - Signature: `type RouteDefinition = RouteDefinition`
- **`RouteEvalResult`**
  - Signature: `type RouteEvalResult = RouteEvalResult`
- **`DeliveryResult`**
  - Signature: `type DeliveryResult = DeliveryResult`

## Onboarding Sources

### `./context/sources/budget-guidance.js`

- **`resolveBudgetGuidanceSource`**
  - Description: Clawforce — Budget Guidance Briefing Source Runtime budget guidance injected into manager reflection. Delegates to the forecast module for daily snapshot, weekly trend, and monthly projection data.
  - Signature: `function resolveBudgetGuidanceSource(projectId: string, params: Record<string, unknown> | undefined): string | null`

### `./context/sources/onboarding-sources.js`

- **`resolveWelcomeSource`**
  - Signature: `function resolveWelcomeSource(projectId: string, db: DatabaseSync, ctx: WelcomeContext): string | null`
- **`resolveWeeklyDigestSource`**
  - Signature: `function resolveWeeklyDigestSource(projectId: string, db: DatabaseSync): string | null`
- **`resolveInterventionSource`**
  - Signature: `function resolveInterventionSource(projectId: string, db: DatabaseSync, agentIds: string[]): string | null`

### `./profiles.js`

- **`generateDefaultScopePolicies`**
  - Description: Generate default action_scope policies from agent roles. Skips agents that already have an explicit action_scope policy targeting them.
  - Signature: `function generateDefaultScopePolicies(agents: Record<string, { extends?: string; }>, existingPolicies?: Array<{ type: string; target?: string; }>): Array<{ name: string; type: string; target: string; config: Record<string, unknown>; }>`

### `./presets.js`

- **`resolveConfig`**
  - Signature: `function resolveConfig<T extends Record<string, unknown>>(config: T & { extends?: string; }, presets: Record<string, Record<string, unknown>>): T`
- **`mergeArrayWithOperators`**
  - Description: Clawforce — Config Inheritance / Preset Resolution Walks `extends` chains, deep-merges configs, supports +/- array operators.
  - Signature: `function mergeArrayWithOperators(parent: string[] | undefined, child: string[]): string[]`
- **`detectCycle`**
  - Signature: `function detectCycle(startName: string, lookup: PresetLookup): string | null`
- **`BUILTIN_AGENT_PRESETS`**
  - Signature: `const BUILTIN_AGENT_PRESETS: Record<string, Record<string, unknown>>`
- **`BUILTIN_JOB_PRESETS`**
  - Signature: `const BUILTIN_JOB_PRESETS: Record<string, Record<string, unknown>>`

## Enforcement

### `./enforcement/tracker.js`

- **`startTracking`**
  - Description: Start tracking a session. Called when an agent with enforcement config starts.
  - Signature: `function startTracking(sessionKey: string, agentId: string, projectId: string, config: AgentConfig, jobName?: string): void`
- **`recordToolCall`**
  - Description: Record a tool call. Called from after_tool_call hook.
  - Signature: `function recordToolCall(sessionKey: string, toolName: string, action: string | null, durationMs: number, success: boolean): void`
- **`recordToolCallDetail`**
  - Description: Record a full tool call detail into the session buffer for telemetry flush.
  - Signature: `function recordToolCallDetail(sessionKey: string, toolName: string, action: string | null, input: string, output: string, durationMs: number, success: boolean, errorMessage?: string): void`
- **`endSession`**
  - Description: Remove session tracking (after enforcement check).
  - Signature: `function endSession(sessionKey: string): SessionCompliance | null`
- **`getSession`**
  - Description: Get compliance state for a session.
  - Signature: `function getSession(sessionKey: string): SessionCompliance | null`
- **`recoverOrphanedSessions`**
  - Description: Find and clean up sessions from crashed processes. Returns orphaned session info for diagnostic logging.
  - Signature: `function recoverOrphanedSessions(projectId: string): OrphanedSession[]`

### `./enforcement/check.js`

- **`checkCompliance`**
  - Description: Check compliance for a session.
  - Signature: `function checkCompliance(session: SessionCompliance): ComplianceResult`

### `./enforcement/actions.js`

- **`executeFailureAction`**
  - Description: Execute the configured failure action for a non-compliant session. Retry count is read from the durable store (not session-ephemeral).
  - Signature: `function executeFailureAction(policyConfig: PerformancePolicy, result: ComplianceResult): FailureActionResult`
- **`executeCrashAction`**
  - Description: Execute failure action for a crashed session (no compliance check possible). Retry count is read from the durable store.
  - Signature: `function executeCrashAction(policyConfig: PerformancePolicy, projectId: string, agentId: string, sessionKey: string, error: string | undefined, metrics: SessionMetrics | null, jobName?: string): FailureActionResult`
- **`recordCompliantRun`**
  - Description: Record a successful compliant session.
  - Signature: `function recordCompliantRun(result: ComplianceResult): void`

### `./enforcement/escalation-router.js`

- **`resolveEscalationTarget`**
  - Description: Resolve where a failure should be escalated based on config.
  - Signature: `function resolveEscalationTarget(config: AgentConfig): EscalationTarget`
- **`routeEscalation`**
  - Description: Route an escalation message to the appropriate target. Supports escalation chaining: tries each level up the org chart. - "parent": logs the alert (auto-announce already delivers via subagent_ended). - "named_agent": injects the message into `agent:<agentId>` session. If injection fails, tries the next level in the escalation chain.
  - Signature: `function routeEscalation(params: EscalationParams): Promise<void>`

### `./enforcement/disabled-store.js`

- **`disableAgent`**
  - Signature: `function disableAgent(projectId: string, agentId: string, reason: string, dbOverride?: DatabaseSync): void`
- **`enableAgent`**
  - Signature: `function enableAgent(projectId: string, agentId: string, dbOverride?: DatabaseSync): void`
- **`isAgentDisabled`**
  - Signature: `function isAgentDisabled(projectId: string, agentId: string, dbOverride?: DatabaseSync): boolean`
- **`disableScope`**
  - Description: Disable a scope (agent, team, or department) for a project.
  - Signature: `function disableScope(projectId: string, scopeType: DisableScope, scopeValue: string, reason: string, disabledBy?: string, dbOverride?: DatabaseSync): void`
- **`enableScope`**
  - Description: Enable (remove disable) a scope for a project.
  - Signature: `function enableScope(projectId: string, scopeType: DisableScope, scopeValue: string, dbOverride?: DatabaseSync): void`
- **`isAgentEffectivelyDisabled`**
  - Description: Check whether an agent is effectively disabled — either directly, or via a team/department scope, or via the legacy disabled_agents table. To avoid circular imports when `getAgentConfig` is not available (or when the caller already has the agent's team/department), pass them as optional params.
  - Signature: `function isAgentEffectivelyDisabled(projectId: string, agentId: string, dbOverride?: DatabaseSync, opts?: { team?: string; department?: string; }): boolean`
- **`listDisabledScopes`**
  - Description: List all disabled scopes for a project.
  - Signature: `function listDisabledScopes(projectId: string, dbOverride?: DatabaseSync): DisabledScopeEntry[]`

### `./enforcement/disabled-store.js`

- **`DisableScope`**
  - Signature: `type DisableScope = DisableScope`
- **`DisabledScopeEntry`**
  - Signature: `type DisabledScopeEntry = DisabledScopeEntry`

### `./enforcement/auto-recovery.js`

- **`checkAutoRecovery`**
  - Description: Check disabled agents for auto-recovery eligibility. Called on each sweep tick.
  - Signature: `function checkAutoRecovery(projectId: string, dbOverride?: DatabaseSync): RecoveryCheck`

## Context Assembly

### `./context/assembler.js`

- **`assembleContext`**
  - Description: Assemble the session-start context for an agent. Returns a markdown string to inject via before_prompt_build.
  - Signature: `function assembleContext(agentId: string, config: AgentConfig, opts?: { projectId?: string; projectDir?: string; budgetChars?: number; sessionKey?: string; }): string`

### `./context/onboarding.js`

- **`buildOnboardingContext`**
  - Description: Build a short onboarding prompt for agents. Keeps injected context minimal — the full reference is in `clawforce_setup explain`.
  - Signature: `function buildOnboardingContext(projectsDir: string): string`
- **`buildExplainContent`**
  - Description: Full reference documentation for the explain action. Delegates to the skill system for domain knowledge, then appends setup-specific instructions that require the projectsDir.
  - Signature: `function buildExplainContent(projectsDir: string): string`

## Jobs (Scoped Sessions)

### `./jobs.js`

- **`resolveJobName`**
  - Description: Extract the job name from a cron prompt message. Returns null if no job tag is found.
  - Signature: `function resolveJobName(prompt: string | undefined): string | null`
- **`resolveEffectiveConfig`**
  - Description: Compute the effective AgentConfig for a job-scoped session. Resolution rules: - briefing: job replaces if specified, else base minus exclude_briefing - expectations, performance_policy, compaction: job replaces if specified, else inherit base - "instructions" source auto-prepended if missing from effective briefing - Base identity fields (extends, title, persona, etc.) are preserved Returns null if the job name is not found in the agent's jobs map.
  - Signature: `function resolveEffectiveConfig(base: AgentConfig, jobName: string): AgentConfig | null`
- **`canManageJobs`**
  - Description: Check if callerAgent can manage targetAgent's jobs. Self-management is always allowed. Managers can manage their direct reports.
  - Signature: `function canManageJobs(projectId: string, callerAgentId: string, targetAgentId: string): boolean`
- **`listJobs`**
  - Description: List all jobs defined on an agent. Returns empty record if agent has no jobs, null if agent not found.
  - Signature: `function listJobs(agentId: string): Record<string, JobDefinition> | null`
- **`upsertJob`**
  - Description: Add or update a job on an agent (in-memory only). Returns false if agent not found.
  - Signature: `function upsertJob(agentId: string, jobName: string, job: JobDefinition): boolean`
- **`deleteJob`**
  - Description: Remove a job from an agent (in-memory only). Returns false if agent or job not found.
  - Signature: `function deleteJob(agentId: string, jobName: string): boolean`

## Skills

### `./skills/registry.js`

- **`resolveSkillSource`**
  - Description: Resolve skill content for an agent. - Without a topic: returns a table of contents of available topics. - With a topic ID: returns the full generated content for that topic. - projectId enables custom topics from project config.
  - Signature: `function resolveSkillSource(preset: string, topic?: string, excludeTopics?: string[], projectId?: string): string | null`
- **`getTopicList`**
  - Description: Get the list of topics available for a given preset. Empty presets array means the topic is available to all presets. When projectId is provided, includes custom topics from that project.
  - Signature: `function getTopicList(preset: string, projectId?: string): Array<{ id: string; title: string; description: string; }>`
- **`registerCustomSkills`**
  - Description: Register custom skill topics from a project's config. Called during project initialization when project.yaml has a `skills` section.
  - Signature: `function registerCustomSkills(projectId: string, skills: Record<string, { title: string; description: string; path: string; presets?: string[]; }>, projectDir: string): void`
- **`SKILL_TOPICS`**
  - Description: All registered skill topics. Order determines display order in the table of contents.
  - Signature: `const SKILL_TOPICS: SkillTopic[]`

## Tools

### `./tools/common.js`

- **`adaptTool`**
  - Description: Adapt our tool shape to AnyAgentTool. Centralizes the single cast needed for cross-package type compatibility. Our ToolResult is structurally identical to AgentToolResult<unknown>, but TypeScript can't verify this across package boundaries.
  - Signature: `function adaptTool(tool: { label: string; name: string; description: string; parameters: unknown; execute: (...args: any[]) => Promise<ToolResult>; }): any`
- **`jsonResult`**
  - Description: Return a JSON text result from a tool.
  - Signature: `function jsonResult(value: unknown): ToolResult`
- **`errorResult`**
  - Description: Return a standardized error result from a tool.
  - Signature: `function errorResult(reason: string): ToolResult`
- **`safeExecute`**
  - Description: Wrap a tool execute body to catch thrown errors (e.g. from readStringParam required checks) and return them as structured error results instead of propagating exceptions.
  - Signature: `function safeExecute(fn: () => Promise<ToolResult>): Promise<ToolResult>`

### `./tools/task-tool.js`

- **`createClawforceTaskTool`**
  - Signature: `function createClawforceTaskTool(options?: { agentSessionKey?: string; projectId?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"fail" | "list" | "get_approval_context" | "get" | "history" | "create" | "transition" | "attach_evidence" | "submit_proposal" | "check_proposal" | "metrics" | "bulk_create" | "bulk_transition" | "add_dep" | "remove_dep" | "list_deps" | "list_dependents" | "list_blockers">; project_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; task_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; assigned_to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; to_state: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; evidence_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; evidence_type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; evidence_content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; max_retries: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; deadline: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; workflow_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; state: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; goal_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; department: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; team: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; proposal_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; key: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; since: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; depends_on_task_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; dep_type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; tasks: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{ title: import("@sinclair/typebox").TString; description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; assigned_to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; max_retries: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; deadline: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; workflow_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; goal_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>>>; transitions: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{ task_id: import("@sinclair/typebox").TString; to_state: import("@sinclair/typebox").TString; reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>>>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/log-tool.js`

- **`createClawforceLogTool`**
  - Signature: `function createClawforceLogTool(options?: { agentSessionKey?: string; agentId?: string; projectId?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"list" | "search" | "write" | "outcome" | "verify_audit" | "record_decision">; project_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; category: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; task_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; summary: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; details: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; artifacts: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; observation: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; orientation: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; decision: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; rationale: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; query: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/setup-tool.js`

- **`createClawforceSetupTool`**
  - Signature: `function createClawforceSetupTool(options: { projectsDir: string; agentId?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"status" | "explain" | "validate" | "activate" | "scaffold">; yaml_content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; config_path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; project_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; agent_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; topic: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/verify-tool.js`

- **`createClawforceVerifyTool`**
  - Signature: `function createClawforceVerifyTool(options?: { agentSessionKey?: string; projectId?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"request" | "verdict">; project_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; task_id: import("@sinclair/typebox").TString; project_dir: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; profile: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; prompt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; passed: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TBoolean]>>; reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/compact-tool.js`

- **`createClawforceCompactTool`**
  - Signature: `function createClawforceCompactTool(options: { projectDir: string; agentSessionKey?: string; agentId?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"update_doc" | "read_doc">; file_path: import("@sinclair/typebox").TString; content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/workflow-tool.js`

- **`createClawforceWorkflowTool`**
  - Signature: `function createClawforceWorkflowTool(options?: { agentSessionKey?: string; projectId?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"list" | "get" | "create" | "add_task" | "advance" | "force_advance" | "phase_status">; project_id: import("@sinclair/typebox").TString; workflow_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; phases: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{ name: import("@sinclair/typebox").TString; description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; gate_condition: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>>>; phase: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; task_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/ops-tool.js`

- **`createClawforceOpsTool`**
  - Signature: `function createClawforceOpsTool(options?: { agentSessionKey?: string; projectId?: string; projectDir?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"agent_status" | "enqueue_work" | "emit_event" | "kill_agent" | "disable_agent" | "enable_agent" | "reassign" | "query_audit" | "trigger_sweep" | "dispatch_worker" | "refresh_context" | "list_events" | "queue_status" | "process_events" | "dispatch_metrics" | "emergency_stop" | "route" | "list_jobs" | "create_job" | "update_job" | "delete_job" | "introspect" | "allocate_budget" | "plan_create" | "plan_start" | "plan_complete" | "plan_abandon" | "plan_list" | "flag_knowledge" | "approve_promotion" | "dismiss_promotion" | "resolve_flag" | "dismiss_flag" | "list_candidates" | "list_flags" | "init_questions" | "init_apply" | "emergency_resume" | "create_experiment" | "start_experiment" | "pause_experiment" | "complete_experiment" | "kill_experiment" | "apply_experiment" | "experiment_status" | "list_experiments">; project_id: import("@sinclair/typebox").TString; session_key: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; agent_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; scope_type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; scope_value: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; force: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>; task_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; new_assignee: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; actor: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; audit_action: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; target_type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; target_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; since: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; audit_table: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; task_id_dispatch: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; project_dir: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; prompt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; profile: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; model: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; timeout_ms: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; allowed_tools: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; max_turns: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; agent_id_context: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; event_type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; event_payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; dedup_key: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; event_status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; event_type_filter: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; enqueue_task_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; enqueue_priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; enqueue_payload: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; target_agent_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; job_name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; job_config: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; filter_job_name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; parent_agent_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; child_agent_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; daily_limit_cents: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; planned_items: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; plan_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; actual_results: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; source_type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; source_ref: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; flagged_content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; correction: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; severity: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; candidate_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; flag_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; init_answers: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; config_dir: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; route_name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; route_config: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; stream_data: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; experiment_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; experiment_name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; experiment_description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; experiment_hypothesis: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; experiment_variants: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; experiment_strategy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; experiment_criteria: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; experiment_auto_apply: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>; experiment_state_filter: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/context-tool.js`

- **`createClawforceContextTool`**
  - Signature: `function createClawforceContextTool(options?: { agentSessionKey?: string; agentId?: string; projectId?: string; projectDir?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"expand" | "get_file" | "list_skills" | "get_skill" | "get_knowledge">; project_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; source: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; detail: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; topic: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; category: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/message-tool.js`

- **`createClawforceMessageTool`**
  - Signature: `function createClawforceMessageTool(options?: { agentSessionKey?: string; agentId?: string; projectId?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"request" | "read" | "list" | "send" | "reply" | "delegate" | "request_feedback" | "respond" | "accept" | "reject" | "complete" | "submit_review" | "list_protocols">; project_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; to: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; status: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; filter_type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; message_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; deadline: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; artifact: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; review_criteria: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; verdict: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; task_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; note: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/goal-tool.js`

- **`createClawforceGoalTool`**
  - Signature: `function createClawforceGoalTool(options?: { agentSessionKey?: string; projectId?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"list" | "status" | "get" | "create" | "decompose" | "achieve" | "abandon">; project_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; goal_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; title: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; acceptance_criteria: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; parent_goal_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; owner_agent_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; department: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; team: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; reason: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; allocation: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; priority: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnsafe<string>>; status_filter: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; sub_goals: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{ title: import("@sinclair/typebox").TString; description: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; acceptance_criteria: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; owner_agent_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; department: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; team: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; }>>>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

### `./tools/channel-tool.js`

- **`createClawforceChannelTool`**
  - Signature: `function createClawforceChannelTool(options?: { agentSessionKey?: string; projectId?: string; }): { label: string; name: string; description: string; parameters: import("@sinclair/typebox").TObject<{ action: import("@sinclair/typebox").TUnsafe<"list" | "join" | "send" | "history" | "meeting_status" | "leave" | "create" | "start_meeting">; project_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; channel_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; channel_name: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; type: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; content: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; members: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; participants: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>; prompt: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; telegram_group_id: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>; limit: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>; }>; execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>; }`

## Policy

### `./policy/registry.js`

- **`registerPolicies`**
  - Description: Register policies from project config into the in-memory cache and DB.
  - Signature: `function registerPolicies(projectId: string, policies: Array<{ name: string; type: string; target?: string; config: Record<string, unknown>; }>, dbOverride?: DatabaseSync): void`

### `./policy/middleware.js`

- **`withPolicyCheck`**
  - Description: Wrap a tool's execute function with policy checking (defense-in-depth). Calls enforceToolPolicy() and formats the result as a tool response.
  - Signature: `function withPolicyCheck(execute: ToolExecuteFunction, context: PolicyMiddlewareContext): ToolExecuteFunction`

## Approval

### `./approval/resolve.js`

- **`approveProposal`**
  - Description: Approve a proposal.
  - Signature: `function approveProposal(projectId: string, proposalId: string, feedback?: string): Proposal | null`
- **`listPendingProposals`**
  - Description: List pending proposals for a project.
  - Signature: `function listPendingProposals(projectId: string): Proposal[]`
- **`rejectProposal`**
  - Description: Reject a proposal.
  - Signature: `function rejectProposal(projectId: string, proposalId: string, feedback?: string): Proposal | null`

### `./approval/channel-router.js`

- **`resolveApprovalChannel`**
  - Description: Resolve the approval notification channel for an agent. Falls back to "dashboard" when unset or unknown.
  - Signature: `function resolveApprovalChannel(projectId: string, agentId: string): ChannelConfig`

### `./approval/channel-router.js`

- **`ApprovalChannel`**
  - Description: Clawforce — Approval channel router Resolves which notification channel to use for a given agent's proposals. Reads the `channel` field from AgentConfig, defaults to "dashboard" (silent).
  - Signature: `type ApprovalChannel = ApprovalChannel`
- **`ChannelConfig`**
  - Signature: `type ChannelConfig = ChannelConfig`

### `./approval/notify.js`

- **`setApprovalNotifier`**
  - Description: Register the approval notifier (called by adapter during setup).
  - Signature: `function setApprovalNotifier(n: ApprovalNotifier | null): void`
- **`getApprovalNotifier`**
  - Description: Get the registered approval notifier. Falls back to the unified delivery adapter if no explicit notifier is set.
  - Signature: `function getApprovalNotifier(): ApprovalNotifier | null`
- **`formatTelegramMessage`**
  - Description: Format a proposal notification message for Telegram (Markdown).
  - Signature: `function formatTelegramMessage(payload: NotificationPayload): string`
- **`buildApprovalButtons`**
  - Description: Build Telegram inline keyboard buttons for approve/reject.
  - Signature: `function buildApprovalButtons(projectId: string, proposalId: string): Array<Array<{ text: string; callback_data: string; }>>`

### `./approval/notify.js`

- **`ApprovalNotifier`**
  - Signature: `type ApprovalNotifier = ApprovalNotifier`
- **`NotificationPayload`**
  - Signature: `type NotificationPayload = NotificationPayload`
- **`NotificationResult`**
  - Signature: `type NotificationResult = NotificationResult`

### `./approval/intent-store.js`

- **`persistToolCallIntent`**
  - Description: Persist a blocked tool call intent.
  - Signature: `function persistToolCallIntent(params: { proposalId: string; projectId: string; agentId: string; taskId?: string; toolName: string; toolParams: Record<string, unknown>; category: string; riskTier: string; }, dbOverride?: DatabaseSync): string`
- **`getIntentByProposalForProject`**
  - Description: Get a tool call intent by proposal ID, searching within a specific project.
  - Signature: `function getIntentByProposalForProject(projectId: string, proposalId: string, dbOverride?: DatabaseSync): ToolCallIntent | null`
- **`getApprovedIntentsForTask`**
  - Description: Get approved intents for a task (used for context injection).
  - Signature: `function getApprovedIntentsForTask(projectId: string, taskId: string, dbOverride?: DatabaseSync): ToolCallIntent[]`
- **`resolveIntentForProject`**
  - Description: Resolve an intent by project ID.
  - Signature: `function resolveIntentForProject(projectId: string, intentId: string, status: "approved" | "rejected", dbOverride?: DatabaseSync): void`

### `./approval/intent-store.js`

- **`ToolCallIntent`**
  - Signature: `type ToolCallIntent = ToolCallIntent`

### `./approval/pre-approved.js`

- **`addPreApproval`**
  - Description: Add a pre-approval for a specific tool call on a task.
  - Signature: `function addPreApproval(params: { projectId: string; taskId: string; toolName: string; category: string; ttlMs?: number; }, dbOverride?: DatabaseSync): void`
- **`checkPreApproval`**
  - Description: Check if a pre-approval exists for a tool call on a task. Does NOT consume the approval — use consumePreApproval for that.
  - Signature: `function checkPreApproval(params: { projectId: string; taskId: string; toolName: string; }, dbOverride?: DatabaseSync): boolean`
- **`consumePreApproval`**
  - Description: Consume a pre-approval (single use). Returns true if a valid pre-approval was found and consumed.
  - Signature: `function consumePreApproval(params: { projectId: string; taskId: string; toolName: string; }, dbOverride?: DatabaseSync): boolean`

## Messaging

### `./messaging/store.js`

- **`createMessage`**
  - Description: Create a new message.
  - Signature: `function createMessage(params: { fromAgent: string; toAgent: string; projectId: string; type?: MessageType; priority?: MessagePriority; content: string; channelId?: string; parentMessageId?: string; protocolStatus?: ProtocolStatus; responseDeadline?: number; metadata?: Record<string, unknown>; }, dbOverride?: DatabaseSync): Message`
- **`getMessage`**
  - Description: Get a single message by ID.
  - Signature: `function getMessage(projectId: string, id: string, dbOverride?: DatabaseSync): Message | null`
- **`getPendingMessages`**
  - Description: Get pending (queued) messages for an agent.
  - Signature: `function getPendingMessages(projectId: string, toAgent: string, dbOverride?: DatabaseSync): Message[]`
- **`listMessages`**
  - Description: List messages for a recipient with optional filters.
  - Signature: `function listMessages(projectId: string, toAgent: string, filter?: { status?: MessageStatus; type?: MessageType; limit?: number; since?: number; }, dbOverride?: DatabaseSync): Message[]`
- **`listSentMessages`**
  - Description: List sent messages from an agent.
  - Signature: `function listSentMessages(projectId: string, fromAgent: string, filter?: { limit?: number; since?: number; }, dbOverride?: DatabaseSync): Message[]`
- **`markDelivered`**
  - Description: Mark a message as delivered.
  - Signature: `function markDelivered(id: string, dbOverride?: DatabaseSync): void`
- **`markBulkDelivered`**
  - Description: Mark multiple messages as delivered in bulk.
  - Signature: `function markBulkDelivered(ids: string[], dbOverride?: DatabaseSync): void`
- **`markRead`**
  - Description: Mark a message as read (read receipt).
  - Signature: `function markRead(projectId: string, id: string, dbOverride?: DatabaseSync): void`
- **`getThread`**
  - Description: Get conversation thread (message + all replies).
  - Signature: `function getThread(projectId: string, parentMessageId: string, dbOverride?: DatabaseSync): Message[]`
- **`searchMessages`**
  - Description: Search messages across agents (for dashboard).
  - Signature: `function searchMessages(projectId: string, filter?: { agentId?: string; type?: MessageType; status?: MessageStatus; since?: number; limit?: number; }, dbOverride?: DatabaseSync): { messages: Message[]; hasMore: boolean; }`
- **`updateProtocolStatus`**
  - Description: Update the protocol status and optionally metadata on a message.
  - Signature: `function updateProtocolStatus(messageId: string, protocolStatus: ProtocolStatus, metadata?: Record<string, unknown>, dbOverride?: DatabaseSync): void`

### `./messaging/notify.js`

- **`setMessageNotifier`**
  - Signature: `function setMessageNotifier(n: MessageNotifier | null): void`
- **`getMessageNotifier`**
  - Signature: `function getMessageNotifier(): MessageNotifier | null`
- **`formatMessageNotification`**
  - Description: Format a message notification for Telegram (Markdown V2 safe).
  - Signature: `function formatMessageNotification(message: Message): string`
- **`notifyMessage`**
  - Description: Attempt to notify the recipient via their configured channel. Fire-and-forget with error boundary. Falls back to unified delivery adapter when no explicit notifier is set.
  - Signature: `function notifyMessage(message: Message): Promise<void>`

### `./messaging/notify.js`

- **`MessageNotifier`**
  - Signature: `type MessageNotifier = MessageNotifier`

## Goals

### `./goals/ops.js`

- **`createGoal`**
  - Signature: `function createGoal(params: CreateGoalParams, dbOverride?: DatabaseSync): Goal`
- **`getGoal`**
  - Signature: `function getGoal(projectId: string, goalId: string, dbOverride?: DatabaseSync): Goal | null`
- **`listGoals`**
  - Signature: `function listGoals(projectId: string, filters?: ListGoalsFilters, dbOverride?: DatabaseSync): Goal[]`
- **`updateGoal`**
  - Signature: `function updateGoal(projectId: string, goalId: string, updates: UpdateGoalParams, dbOverride?: DatabaseSync): Goal`
- **`achieveGoal`**
  - Signature: `function achieveGoal(projectId: string, goalId: string, actor: string, dbOverride?: DatabaseSync): Goal`
- **`abandonGoal`**
  - Signature: `function abandonGoal(projectId: string, goalId: string, actor: string, reason?: string, dbOverride?: DatabaseSync): Goal`
- **`getChildGoals`**
  - Signature: `function getChildGoals(projectId: string, goalId: string, dbOverride?: DatabaseSync): Goal[]`
- **`getGoalTree`**
  - Signature: `function getGoalTree(projectId: string, goalId: string, dbOverride?: DatabaseSync): GoalTreeNode | null`
- **`linkTaskToGoal`**
  - Signature: `function linkTaskToGoal(projectId: string, taskId: string, goalId: string, dbOverride?: DatabaseSync): void`
- **`unlinkTaskFromGoal`**
  - Signature: `function unlinkTaskFromGoal(projectId: string, taskId: string, dbOverride?: DatabaseSync): void`
- **`getGoalTasks`**
  - Signature: `function getGoalTasks(projectId: string, goalId: string, dbOverride?: DatabaseSync): Task[]`
- **`findRootInitiative`**
  - Description: Walk up the goal hierarchy to find the root goal with an allocation > 0. Returns null if no ancestor (including the goal itself) has an allocation. Includes cycle protection via a visited set.
  - Signature: `function findRootInitiative(projectId: string, goalId: string, dbOverride?: DatabaseSync): Goal | null`
- **`getInitiativeSpend`**
  - Description: Get today's total spend (in cents) for all tasks under a goal tree. Collects all goal IDs recursively (BFS from rootGoalId down through children), then sums cost_records for tasks linked to those goals created today.
  - Signature: `function getInitiativeSpend(projectId: string, rootGoalId: string, dbOverride?: DatabaseSync): number`

### `./goals/ops.js`

- **`CreateGoalParams`**
  - Signature: `type CreateGoalParams = CreateGoalParams`
- **`ListGoalsFilters`**
  - Signature: `type ListGoalsFilters = ListGoalsFilters`
- **`GoalTreeNode`**
  - Signature: `type GoalTreeNode = GoalTreeNode`

### `./goals/cascade.js`

- **`checkGoalCascade`**
  - Signature: `function checkGoalCascade(projectId: string, dbOverride?: DatabaseSync): CascadeResult`
- **`computeGoalProgress`**
  - Signature: `function computeGoalProgress(projectId: string, goalId: string, dbOverride?: DatabaseSync): GoalProgress`

### `./goals/cascade.js`

- **`GoalProgress`**
  - Signature: `type GoalProgress = GoalProgress`
- **`CascadeResult`**
  - Signature: `type CascadeResult = CascadeResult`

## Channels

### `./channels/store.js`

- **`createChannel`**
  - Signature: `function createChannel(params: { projectId: string; name: string; type?: ChannelType; members?: string[]; createdBy: string; metadata?: Record<string, unknown>; }, dbOverride?: DatabaseSync): Channel`
- **`getChannel`**
  - Signature: `function getChannel(projectId: string, channelId: string, dbOverride?: DatabaseSync): Channel | null`
- **`getChannelByName`**
  - Signature: `function getChannelByName(projectId: string, name: string, dbOverride?: DatabaseSync): Channel | null`
- **`listChannels`**
  - Signature: `function listChannels(projectId: string, filter?: { type?: ChannelType; status?: ChannelStatus; memberAgent?: string; limit?: number; }, dbOverride?: DatabaseSync): Channel[]`
- **`addMember`**
  - Signature: `function addMember(projectId: string, channelId: string, agentId: string, dbOverride?: DatabaseSync): Channel`
- **`removeMember`**
  - Signature: `function removeMember(projectId: string, channelId: string, agentId: string, dbOverride?: DatabaseSync): Channel`
- **`updateChannelMetadata`**
  - Signature: `function updateChannelMetadata(projectId: string, channelId: string, metadata: Record<string, unknown>, dbOverride?: DatabaseSync): void`
- **`concludeChannel`**
  - Signature: `function concludeChannel(projectId: string, channelId: string, dbOverride?: DatabaseSync): Channel`
- **`archiveChannel`**
  - Signature: `function archiveChannel(projectId: string, channelId: string, dbOverride?: DatabaseSync): Channel`
- **`getChannelMessages`**
  - Signature: `function getChannelMessages(projectId: string, channelId: string, filter?: { limit?: number; since?: number; }, dbOverride?: DatabaseSync): Message[]`

### `./channels/messages.js`

- **`sendChannelMessage`**
  - Description: Send a message to a channel. Uses the unified messages table with channel_id set. toAgent is set to "channel:<name>" for broadcast semantics.
  - Signature: `function sendChannelMessage(params: { fromAgent: string; channelId: string; projectId: string; content: string; type?: MessageType; metadata?: Record<string, unknown>; }, dbOverride?: DatabaseSync): Message`
- **`buildChannelTranscript`**
  - Description: Build a formatted markdown transcript of channel messages. Used for context injection into agent sessions.
  - Signature: `function buildChannelTranscript(projectId: string, channelId: string, opts?: { maxChars?: number; since?: number; limit?: number; }, dbOverride?: DatabaseSync): string`

### `./channels/meeting.js`

- **`startMeeting`**
  - Description: Start a meeting: create/reuse a meeting channel and dispatch the first participant.
  - Signature: `function startMeeting(params: { projectId: string; channelName?: string; channelId?: string; participants: string[]; prompt?: string; initiator: string; }, dbOverride?: DatabaseSync): { channel: Channel; dispatched: boolean; }`
- **`advanceMeetingTurn`**
  - Description: Advance to the next meeting turn. Called by the event router when meeting_turn_completed fires.
  - Signature: `function advanceMeetingTurn(projectId: string, channelId: string, dbOverride?: DatabaseSync): { nextAgent: string | null; turnIndex: number; done: boolean; }`
- **`concludeMeeting`**
  - Description: Conclude a meeting. Sets status to "concluded".
  - Signature: `function concludeMeeting(projectId: string, channelId: string, actor: string, dbOverride?: DatabaseSync): Channel`
- **`getMeetingStatus`**
  - Description: Get the current meeting status.
  - Signature: `function getMeetingStatus(projectId: string, channelId: string, dbOverride?: DatabaseSync): { channel: Channel; currentTurn: number; participants: string[]; transcript: string; done: boolean; } | null`

### `./channels/notify.js`

- **`setChannelNotifier`**
  - Signature: `function setChannelNotifier(n: ChannelNotifier | null): void`
- **`getChannelNotifier`**
  - Signature: `function getChannelNotifier(): ChannelNotifier | null`
- **`notifyChannelMessage`**
  - Description: Attempt to notify a channel message via Telegram. Fire-and-forget with error boundary. Falls back to unified delivery adapter when no explicit notifier is set.
  - Signature: `function notifyChannelMessage(channel: Channel, message: Message): Promise<void>`

## Channel Delivery

### `./channels/deliver.js`

- **`setDeliveryAdapter`**
  - Signature: `function setDeliveryAdapter(a: DeliveryAdapter | null): void`
- **`getDeliveryAdapter`**
  - Signature: `function getDeliveryAdapter(): DeliveryAdapter | null`
- **`deliverMessage`**
  - Signature: `function deliverMessage(req: DeliveryRequest): Promise<DeliveryResult>`
- **`clearDeliveryAdapter`**
  - Signature: `function clearDeliveryAdapter(): void`

### `./channels/deliver.js`

- **`DeliveryAdapter`**
  - Description: Clawforce — Unified Channel Delivery Thin adapter for delivering messages to any channel via OpenClaw's runtime.channel.* APIs. Replaces the three setter-pattern notifiers (approval, messaging, channel).
  - Signature: `type DeliveryAdapter = DeliveryAdapter`
- **`DeliveryRequest`**
  - Signature: `type DeliveryRequest = DeliveryRequest`
- **`ChannelDeliveryResult (re-export of DeliveryResult)`**
  - Signature: `type DeliveryResult = DeliveryResult`

## Audit

### `./audit/auto-kill.js`

- **`registerKillFunction`**
  - Description: Register the kill function (provided by the plugin API / gateway).
  - Signature: `function registerKillFunction(fn: AgentKillFn): void`

## Tasks

### `./tasks/session-end.js`

- **`handleWorkerSessionEnd`**
  - Description: Handle a worker session ending. If the worker didn't transition its task, attach available failure context as evidence and move to FAILED. Returns true if enforcement action was taken.
  - Signature: `function handleWorkerSessionEnd(params: { sessionKey: string; status: "ok" | "error" | "timeout" | "unknown"; error?: string; summary?: string; dbOverride?: DatabaseSync; }): boolean`

## Memory Governance

### `./context/sources/memory-instructions.js`

- **`resolveMemoryInstructions`**
  - Description: Resolve memory instructions content for an agent.
  - Signature: `function resolveMemoryInstructions(memoryConfig: MemoryGovernanceConfig | undefined, extendsFrom: string): string | null`
- **`MANAGER_MEMORY_INSTRUCTIONS`**
  - Signature: `const MANAGER_MEMORY_INSTRUCTIONS: "## Memory Protocol\n\n- Search memory at the START of every coordination cycle for relevant strategic context\n- Before making decisions, check if similar situations have been handled before\n- Write strategic decisions, rationale, and observations to memory using memory tools\n- IMPORTANT: Save memories to the persistent RAG store using the appropriate memory write tools. Do NOT write to memory.md — that file gets truncated on compaction. The persistent memory store is accessed via memory tools.\n- Your memory review job will extract learnings from your reports' sessions — review promotion candidates in your briefing"`
- **`EMPLOYEE_MEMORY_INSTRUCTIONS`**
  - Signature: `const EMPLOYEE_MEMORY_INSTRUCTIONS: "## Memory Protocol\n\n- Your knowledge comes through skills and curated context — check your skill documentation first\n- If you discover something reusable during your task, write it to memory using memory tools (NOT memory.md)\n- memory.md gets truncated on compaction. Use the memory tools for persistent storage.\n- Your learnings will be automatically extracted and reviewed by your manager"`

### `./memory/review-context.js`

- **`buildReviewContext`**
  - Description: Build the full review context for the memory review job.
  - Signature: `function buildReviewContext(opts: ReviewContextOpts): string`

### `./memory/review-context.js`

- **`ReviewContextOpts`**
  - Description: Clawforce — Memory Review Context Source Assembles session transcripts and agent identity context for the memory review job. Reads JSONL transcript files from the agent's session directory.
  - Signature: `type ReviewContextOpts = ReviewContextOpts`

## Memory (Ghost Turn + Flush)

### `./memory/ghost-turn.js`

- **`runGhostRecall`**
  - Description: Full ghost turn pipeline: triage + search + format. This is the entry point called from the adapter's before_prompt_build hook.
  - Signature: `function runGhostRecall(messages: unknown[], tool: MemoryToolInstance | null, opts: GhostTurnOpts): Promise<GhostRecallResult | null>`
- **`runCronRecall`**
  - Description: Ghost recall for cron/autonomous agents. Skips LLM triage — extracts queries from job prompt directly.
  - Signature: `function runCronRecall(prompt: string, tool: MemoryToolInstance | null, opts: { maxSearches: number; maxInjectedChars: number; debug: boolean; sessionKey: string; projectId?: string; agentId?: string; }): Promise<GhostRecallResult | null>`
- **`clearCooldown`**
  - Signature: `function clearCooldown(sessionKey: string): void`
- **`clearAllCooldowns`**
  - Description: For testing only.
  - Signature: `function clearAllCooldowns(): void`
- **`INTENSITY_PRESETS`**
  - Signature: `const INTENSITY_PRESETS: Record<GhostTurnIntensity, { cooldownMs: number; maxSearches: number; }>`

### `./memory/ghost-turn.js`

- **`GhostTurnIntensity`**
  - Signature: `type GhostTurnIntensity = GhostTurnIntensity`
- **`GhostTurnOpts`**
  - Signature: `type GhostTurnOpts = GhostTurnOpts`
- **`GhostRecallResult`**
  - Signature: `type GhostRecallResult = GhostRecallResult`
- **`MemoryToolInstance`**
  - Signature: `type MemoryToolInstance = MemoryToolInstance`

### `./memory/llm-client.js`

- **`resolveProvider`**
  - Description: Detect which LLM provider is available from environment variables. Returns null if no key is found (graceful degradation).
  - Signature: `function resolveProvider(): ProviderInfo | null`
- **`callTriage`**
  - Description: Make a single triage LLM call using the detected provider. Returns parsed TriageResult or null on any failure.
  - Signature: `function callTriage(systemPrompt: string, userContent: string, opts?: { provider?: ProviderInfo; timeoutMs?: number; model?: string; }): Promise<TriageResult | null>`
- **`parseTriageResponse`**
  - Description: Parse the LLM's triage response text into a TriageResult. Handles JSON wrapped in markdown code fences.
  - Signature: `function parseTriageResponse(text: string): TriageResult | null`

### `./memory/llm-client.js`

- **`ProviderInfo`**
  - Description: Lightweight, provider-agnostic LLM client for ghost turn triage. Detects the available provider from shared environment variables (the same ones OpenClaw uses) and routes to the appropriate API. No SDK dependency — raw fetch only.
  - Signature: `type ProviderInfo = ProviderInfo`
- **`TriageResult`**
  - Signature: `type TriageResult = TriageResult`

### `./memory/flush-tracker.js`

- **`isMemoryWriteCall`**
  - Description: Heuristic: detect if a tool call represents a memory write. Checks for: - File-write tools targeting memory/ paths - Any tool with "memory" in the name + write-like action
  - Signature: `function isMemoryWriteCall(toolName: string, params: unknown): boolean`
- **`getFlushPrompt`**
  - Signature: `function getFlushPrompt(fileTargets?: string[]): string`

## Event Actions & Templates

### `./events/template.js`

- **`interpolate`**
  - Description: Interpolate {{path}} references in a template string. Unknown paths resolve to empty string.
  - Signature: `function interpolate(template: string, ctx: TemplateContext): string`
- **`interpolateRecord`**
  - Description: Interpolate a Record's values (used for emit_event payload templates).
  - Signature: `function interpolateRecord(record: Record<string, string>, ctx: TemplateContext): Record<string, string>`

### `./events/template.js`

- **`TemplateContext`**
  - Description: Clawforce — Event template interpolation Simple {{path.to.field}} substitution for event handler configs. Supports: {{payload.field}}, {{event.type}}, {{event.projectId}}, etc.
  - Signature: `type TemplateContext = TemplateContext`

### `./events/actions.js`

- **`executeAction`**
  - Description: Execute a single event action config against an event.
  - Signature: `function executeAction(event: ClawforceEvent, config: EventActionConfig, db: DatabaseSync): ActionResult`

### `./events/actions.js`

- **`ActionResult`**
  - Signature: `type ActionResult = ActionResult`

## Triggers

### `./triggers/conditions.js`

- **`evaluateConditions`**
  - Description: Evaluate all conditions against a payload. Returns { pass: true } only if ALL conditions pass. If conditions is empty or undefined, pass is true (no filter).
  - Signature: `function evaluateConditions(conditions: TriggerCondition[] | undefined, payload: Record<string, unknown>): ConditionsResult`
- **`resolvePath`**
  - Description: Resolve a dotted path (e.g. "data.status.code") against an object. Returns undefined when any segment is missing.
  - Signature: `function resolvePath(obj: unknown, path: string): unknown`

### `./triggers/conditions.js`

- **`ConditionResult`**
  - Description: Result of evaluating a single condition.
  - Signature: `type ConditionResult = ConditionResult`
- **`ConditionsResult`**
  - Description: Result of evaluating all conditions for a trigger.
  - Signature: `type ConditionsResult = ConditionsResult`

### `./triggers/processor.js`

- **`fireTrigger`**
  - Description: Fire a trigger by name.
  - Signature: `function fireTrigger(domain: string, triggerName: string, payload: Record<string, unknown>, source: TriggerSource, dbOverride?: DatabaseSync): TriggerFireResult`
- **`getTriggerDefinitions`**
  - Description: Get all trigger definitions for a domain.
  - Signature: `function getTriggerDefinitions(domain: string): Record<string, TriggerDefinition>`
- **`clearCooldowns`**
  - Description: Clear all cooldowns (for testing).
  - Signature: `function clearCooldowns(): void`

### `./triggers/processor.js`

- **`TriggerFireResult`**
  - Description: Result of a trigger fire attempt.
  - Signature: `type TriggerFireResult = TriggerFireResult`

### `./project.js`

- **`normalizeTriggerConfig`**
  - Signature: `function normalizeTriggerConfig(raw: Record<string, unknown>): Record<string, TriggerDefinition> | undefined`

## Diagnostics

### `./diagnostics.js`

- **`emitDiagnosticEvent`**
  - Signature: `function emitDiagnosticEvent(payload: DiagnosticPayload): void`
- **`setDiagnosticEmitter`**
  - Signature: `function setDiagnosticEmitter(fn: (payload: DiagnosticPayload) => void): void`

## Pricing

### `./pricing.js`

- **`getPricing`**
  - Signature: `function getPricing(model: string): ModelPricing`
- **`registerModelPricing`**
  - Signature: `function registerModelPricing(model: string, pricing: ModelPricing): void`
- **`registerModelPricingFromConfig`**
  - Description: Register pricing from OpenClaw's ModelDefinitionConfig.cost format. OpenClaw costs are in dollars per 1M tokens. We store cents per 1M tokens.
  - Signature: `function registerModelPricingFromConfig(model: string, cost: { input: number; output: number; cacheRead: number; cacheWrite: number; }): void`
- **`registerBulkPricing`**
  - Description: Bulk register from OpenClaw model registry.
  - Signature: `function registerBulkPricing(models: Array<{ id: string; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; }; }>): void`

### `./pricing.js`

- **`ModelPricing`**
  - Description: Clawforce — Dynamic pricing Loads model pricing from OpenClaw's ModelDefinitionConfig at runtime. Falls back to hardcoded defaults for offline/unknown models.
  - Signature: `type ModelPricing = ModelPricing`

## Rate Limits

### `./rate-limits.js`

- **`updateProviderUsage`**
  - Signature: `function updateProviderUsage(provider: string, data: { windows: UsageWindow[]; plan?: string; error?: string; }): void`
- **`getProviderUsage`**
  - Signature: `function getProviderUsage(provider: string): ProviderUsage | undefined`
- **`getAllProviderUsage`**
  - Signature: `function getAllProviderUsage(): ProviderUsage[]`
- **`isProviderThrottled`**
  - Description: Check if any rate limit window for a provider exceeds the threshold. Ignores stale data (older than 10 minutes).
  - Signature: `function isProviderThrottled(provider: string, thresholdPercent?: number): boolean`
- **`getMaxUsagePercent`**
  - Description: Get the highest used percent across all windows for a provider. Ignores stale data.
  - Signature: `function getMaxUsagePercent(provider: string): number`

### `./rate-limits.js`

- **`ProviderUsage`**
  - Signature: `type ProviderUsage = ProviderUsage`
- **`UsageWindow`**
  - Description: Clawforce — Rate limit tracker In-memory store for provider rate limit status. Updated from OpenClaw's ProviderUsageSnapshot data. Queried by capacity planner and dispatch gate.
  - Signature: `type UsageWindow = UsageWindow`

## Cascading Budget

### `./budget-cascade.js`

- **`allocateBudget`**
  - Description: Allocate budget from parent agent to child agent. Supports all dimensions (cents, tokens, requests) and all windows (hourly, daily, monthly). Each dimension is validated independently: sum(children allocations) <= parent limit. Backward compatible: if only `dailyLimitCents` provided, maps to `{ daily: { cents: value } }`.
  - Signature: `function allocateBudget(params: AllocateBudgetParams, dbOverride?: DatabaseSync): AllocateBudgetResult`
- **`getAgentBudgetStatus`**
  - Description: Get budget status for an agent including how much is allocated to reports.
  - Signature: `function getAgentBudgetStatus(projectId: string, agentId: string, dbOverride?: DatabaseSync): AgentBudgetStatus`

### `./budget-cascade.js`

- **`AllocateBudgetParams`**
  - Signature: `type AllocateBudgetParams = AllocateBudgetParams`
- **`AllocateBudgetResult`**
  - Signature: `type AllocateBudgetResult = AllocateBudgetResult`
- **`AgentBudgetStatus`**
  - Signature: `type AgentBudgetStatus = AgentBudgetStatus`

## Multi-Window Budget

### `./budget-windows.js`

- **`getBudgetStatus`**
  - Signature: `function getBudgetStatus(projectId: string, agentId?: string, dbOverride?: DatabaseSync): BudgetStatus`
- **`checkMultiWindowBudget`**
  - Signature: `function checkMultiWindowBudget(params: { projectId: string; agentId?: string; }, dbOverride?: DatabaseSync): BudgetCheckResult`

### `./budget-windows.js`

- **`BudgetStatus`**
  - Signature: `type BudgetStatus = BudgetStatus`
- **`WindowStatus`**
  - Signature: `type WindowStatus = WindowStatus`

## Budget v2

### `./budget/normalize.js`

- **`normalizeBudgetConfig`**
  - Signature: `function normalizeBudgetConfig(config: BudgetConfig | BudgetConfigV2 | undefined): BudgetConfigV2`

### `./budget/reset.js`

- **`ensureWindowsCurrent`**
  - Signature: `function ensureWindowsCurrent(projectId: string, agentId: string | undefined, db: DatabaseSync): void`
- **`getNextHourBoundary`**
  - Signature: `function getNextHourBoundary(now: number): number`
- **`getNextMidnightUTC`**
  - Signature: `function getNextMidnightUTC(now: number): number`
- **`getNextMonthBoundaryUTC`**
  - Signature: `function getNextMonthBoundaryUTC(now: number): number`

### `./budget/check-v2.js`

- **`checkBudgetV2`**
  - Signature: `function checkBudgetV2(params: { projectId: string; agentId?: string; }, db: DatabaseSync): BudgetCheckResult`

### `./budget/reservation.js`

- **`reserveBudget`**
  - Description: Reserve budget for an executing plan. Increments reserved_cents, reserved_tokens, and reserved_requests on the project-level budget row.
  - Signature: `function reserveBudget(projectId: string, cents: number, tokens: number, requests: number, db: DatabaseSync): void`
- **`settlePlanItem`**
  - Description: Settle a single plan item: decrement reservation by the item's estimate. Uses MAX(0, ...) to prevent negative reservations.
  - Signature: `function settlePlanItem(projectId: string, estimatedCents: number, estimatedTokens: number, estimatedRequests: number, db: DatabaseSync): void`
- **`releasePlanReservation`**
  - Description: Release remaining reservation when a plan completes or is abandoned. Decrements by the remaining reservation amount (MAX 0).
  - Signature: `function releasePlanReservation(projectId: string, remainingCents: number, remainingTokens: number, remainingRequests: number, db: DatabaseSync): void`
- **`cleanupStaleReservations`**
  - Description: Clean up stale reservations from plans stuck in 'executing' state. Finds plans with started_at older than now - ttlMs, force-abandons them, and releases their reservations.
  - Signature: `function cleanupStaleReservations(projectId: string, ttlMs: number, db: DatabaseSync): number`

### `./budget/forecast.js`

- **`computeDailySnapshot`**
  - Signature: `function computeDailySnapshot(projectId: string, db: DatabaseSync): DailyBudgetSnapshot`
- **`computeWeeklyTrend`**
  - Signature: `function computeWeeklyTrend(projectId: string, db: DatabaseSync): WeeklyTrend`
- **`computeMonthlyProjection`**
  - Signature: `function computeMonthlyProjection(projectId: string, db: DatabaseSync): MonthlyProjection`

### `./types.js`

- **`BudgetConfigV2`**
  - Signature: `type BudgetConfigV2 = BudgetConfigV2`
- **`BudgetWindowConfig`**
  - Signature: `type BudgetWindowConfig = BudgetWindowConfig`
- **`DailyBudgetSnapshot`**
  - Signature: `type DailyBudgetSnapshot = DailyBudgetSnapshot`
- **`WeeklyTrend`**
  - Signature: `type WeeklyTrend = WeeklyTrend`
- **`MonthlyProjection`**
  - Signature: `type MonthlyProjection = MonthlyProjection`

### `./budget-cascade.js`

- **`BudgetAllocation`**
  - Signature: `type BudgetAllocation = BudgetAllocation`

## Capacity

### `./capacity.js`

- **`getCapacityReport`**
  - Description: Build a capacity report for a project.
  - Signature: `function getCapacityReport(projectId: string, agentId?: string, dbOverride?: DatabaseSync): CapacityReport`

### `./capacity.js`

- **`CapacityReport`**
  - Signature: `type CapacityReport = CapacityReport`
- **`ThrottleRisk`**
  - Signature: `type ThrottleRisk = ThrottleRisk`

## Resources Context

### `./context/sources/resources.js`

- **`buildResourcesContext`**
  - Signature: `function buildResourcesContext(projectId: string, agentId?: string, dbOverride?: DatabaseSync): string | null`

## Budget Parser

### `./budget-parser.js`

- **`parseBudgetShorthand`**
  - Description: Parse budget shorthand string(s) into BudgetConfig. Supports single ("$20/day") or combined ("$5/hour + $100/day + $500/month").
  - Signature: `function parseBudgetShorthand(input: string): Partial<BudgetConfig> | null`

## Cost Auto-Capture

### `./cost.js`

- **`recordCostFromLlmOutput`**
  - Description: Record cost from an OpenClaw llm_output hook event. Convenience wrapper that maps hook event fields to recordCost params.
  - Signature: `function recordCostFromLlmOutput(params: { projectId: string; agentId: string; sessionKey?: string; taskId?: string; provider?: string; model?: string; usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; }; }): CostRecord`

## Scheduling

### `./scheduling/cost-engine.js`

- **`getCostEstimate`**
  - Signature: `function getCostEstimate(projectId: string, initiativeGoalId: string, agentId: string, model: string, dbOverride?: DatabaseSync): CostEstimate`

### `./scheduling/cost-engine.js`

- **`CostEstimate`**
  - Signature: `type CostEstimate = CostEstimate`

### `./scheduling/plans.js`

- **`createPlan`**
  - Signature: `function createPlan(params: CreatePlanParams, dbOverride?: DatabaseSync): DispatchPlan`
- **`getPlan`**
  - Signature: `function getPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): DispatchPlan | null`
- **`startPlan`**
  - Signature: `function startPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): BudgetCheckResult`
- **`completePlan`**
  - Signature: `function completePlan(projectId: string, planId: string, params: CompletePlanParams, dbOverride?: DatabaseSync): void`
- **`abandonPlan`**
  - Signature: `function abandonPlan(projectId: string, planId: string, dbOverride?: DatabaseSync): void`
- **`listPlans`**
  - Signature: `function listPlans(projectId: string, agentId: string, dbOverride?: DatabaseSync, limit?: number): DispatchPlan[]`

### `./scheduling/plans.js`

- **`CreatePlanParams`**
  - Signature: `type CreatePlanParams = CreatePlanParams`
- **`CompletePlanParams`**
  - Signature: `type CompletePlanParams = CompletePlanParams`

### `./scheduling/slots.js`

- **`computeAvailableSlots`**
  - Signature: `function computeAvailableSlots(input: SlotCalcInput): SlotAvailability[]`

### `./scheduling/slots.js`

- **`SlotAvailability`**
  - Signature: `type SlotAvailability = SlotAvailability`
- **`SlotCalcInput`**
  - Signature: `type SlotCalcInput = SlotCalcInput`
- **`ModelConfig`**
  - Description: Clawforce — Rate-Aware Slot Calculator Computes how many concurrent sessions can be started per model given rate limits, active sessions, and average token usage.
  - Signature: `type ModelConfig = ModelConfig`

### `./scheduling/wake-bounds.js`

- **`clampCronToWakeBounds`**
  - Description: Clamp a cron expression to wake bounds [fastest, slowest]. Only enforces for simple star-slash-N minute-interval patterns. Complex expressions pass through unclamped.
  - Signature: `function clampCronToWakeBounds(cron: string, wakeBounds?: [string, string]): string`

### `./scheduling/frequency.js`

- **`parseFrequency`**
  - Description: Parse a frequency string like "3/day" into a structured target. Returns null if the string is invalid.
  - Signature: `function parseFrequency(freq: string): FrequencyTarget | null`
- **`shouldRunNow`**
  - Description: Determine whether a frequency-based job should run now. Decision logic: 1. Never run if minimum interval (80% of target) hasn't elapsed. 2. Always run if max interval (150% of target) exceeded or never run before. 3. Run early if there's pending work (reviews or queue items). 4. Run at the target interval otherwise.
  - Signature: `function shouldRunNow(frequency: FrequencyTarget, lastRunAt: number | null, currentQueueDepth: number, pendingReviews: number, now?: number): ShouldRunResult`

### `./scheduling/frequency.js`

- **`FrequencyTarget`**
  - Description: Clawforce — Frequency-based scheduling Parses "N/period" frequency targets and determines optimal run times based on workload, queue state, and time since last run.
  - Signature: `type FrequencyTarget = FrequencyTarget`
- **`ShouldRunResult`**
  - Signature: `type ShouldRunResult = ShouldRunResult`

### `./scheduling/scheduler.js`

- **`checkFrequencyJobs`**
  - Description: Check all frequency-based jobs for a project and return any that should run. For each agent with frequency-based jobs: 1. Parse the frequency string 2. Look up the last run time from audit_runs 3. Check current queue depth and pending reviews 4. Apply shouldRunNow logic
  - Signature: `function checkFrequencyJobs(projectId: string, dbOverride?: DatabaseSync): FrequencyDispatch[]`

### `./scheduling/scheduler.js`

- **`FrequencyDispatch`**
  - Signature: `type FrequencyDispatch = FrequencyDispatch`

## Knowledge Lifecycle

### `./memory/retrieval-tracker.js`

- **`trackRetrieval`**
  - Signature: `function trackRetrieval(projectId: string, agentId: string, sessionKey: string, content: string, dbOverride?: DatabaseSync): void`
- **`getRetrievalStats`**
  - Signature: `function getRetrievalStats(projectId: string, dbOverride?: DatabaseSync): RetrievalStat[]`
- **`getStatsAboveThreshold`**
  - Signature: `function getStatsAboveThreshold(projectId: string, minRetrievals: number, minSessions: number, dbOverride?: DatabaseSync): RetrievalStat[]`

### `./memory/retrieval-tracker.js`

- **`RetrievalStat`**
  - Signature: `type RetrievalStat = RetrievalStat`

### `./memory/search-dedup.js`

- **`isDuplicateQuery`**
  - Signature: `function isDuplicateQuery(projectId: string, sessionKey: string, query: string, dbOverride?: DatabaseSync): boolean`
- **`logSearchQuery`**
  - Signature: `function logSearchQuery(projectId: string, agentId: string, sessionKey: string, query: string, resultCount: number, dbOverride?: DatabaseSync): void`

### `./memory/promotion.js`

- **`checkPromotionCandidates`**
  - Signature: `function checkPromotionCandidates(projectId: string, threshold: { minRetrievals: number; minSessions: number; }, dbOverride?: DatabaseSync): number`
- **`listCandidates`**
  - Signature: `function listCandidates(projectId: string, dbOverride?: DatabaseSync, statusFilter?: PromotionCandidate["status"]): PromotionCandidate[]`
- **`getCandidate`**
  - Signature: `function getCandidate(projectId: string, candidateId: string, dbOverride?: DatabaseSync): PromotionCandidate | null`
- **`approveCandidate`**
  - Signature: `function approveCandidate(projectId: string, candidateId: string, dbOverride?: DatabaseSync): void`
- **`dismissCandidate`**
  - Signature: `function dismissCandidate(projectId: string, candidateId: string, dbOverride?: DatabaseSync): void`
- **`suggestTarget`**
  - Description: Suggest a promotion target based on content heuristics.
  - Signature: `function suggestTarget(snippet: string): PromotionTarget`

### `./memory/demotion.js`

- **`createFlag`**
  - Signature: `function createFlag(params: CreateFlagParams, dbOverride?: DatabaseSync): KnowledgeFlag`
- **`getFlag`**
  - Signature: `function getFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): KnowledgeFlag | null`
- **`listFlags`**
  - Signature: `function listFlags(projectId: string, statusFilter?: KnowledgeFlag["status"], dbOverride?: DatabaseSync): KnowledgeFlag[]`
- **`resolveFlag`**
  - Signature: `function resolveFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): void`
- **`dismissFlag`**
  - Signature: `function dismissFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): void`

### `./memory/demotion.js`

- **`CreateFlagParams`**
  - Signature: `type CreateFlagParams = CreateFlagParams`

### `./memory/ghost-turn.js`

- **`formatExpectationsReminder`**
  - Description: Format agent expectations as a compressed reminder for re-injection. Returns null if no expectations are provided.
  - Signature: `function formatExpectationsReminder(expectations: Expectation[]): string | null`

### `./adaptation/hire.js`

- **`hireAgent`**
  - Signature: `function hireAgent(projectId: string, spec: HireSpec): HireResult`

### `./adaptation/hire.js`

- **`HireSpec`**
  - Signature: `type HireSpec = HireSpec`
- **`HireResult`**
  - Signature: `type HireResult = HireResult`

### `./adaptation/budget-reallocate.js`

- **`reallocateBudget`**
  - Signature: `function reallocateBudget(projectId: string, params: ReallocateParams, dbOverride?: DatabaseSync): ReallocateResult`

### `./adaptation/budget-reallocate.js`

- **`ReallocateParams`**
  - Signature: `type ReallocateParams = ReallocateParams`
- **`ReallocateResult`**
  - Signature: `type ReallocateResult = ReallocateResult`

### `./adaptation/cards.js`

- **`checkAdaptationPermission`**
  - Description: Check whether a manager can execute an adaptation card at the given trust score. Trust tiers: - Low (< 0.4): all cards require approval except escalation - Medium (0.4-0.7): low-risk auto-approved, medium/high require approval - High (> 0.7): low+medium auto-approved, high requires approval
  - Signature: `function checkAdaptationPermission(cardType: string, trustScore: number): PermissionResult`
- **`ADAPTATION_CARDS`**
  - Signature: `const ADAPTATION_CARDS: Record<string, AdaptationCard>`

### `./adaptation/cards.js`

- **`AdaptationCard`**
  - Signature: `type AdaptationCard = AdaptationCard`
- **`CardRisk`**
  - Description: Clawforce — Adaptation Cards Defines the manager's adaptation toolkit and trust-gated permissions. Each card has a risk level. Trust tier determines whether the card requires human approval or can be auto-approved.
  - Signature: `type CardRisk = CardRisk`
- **`PermissionResult`**
  - Signature: `type PermissionResult = PermissionResult`

### `./adaptation/autonomy-init.js`

- **`initializeAutonomy`**
  - Description: Initialize trust overrides based on DIRECTION.md autonomy level. - low: no overrides (default zero-trust start) - medium: override all adaptation categories to medium tier - high: override all adaptation categories to high tier All overrides decay after 14 days.
  - Signature: `function initializeAutonomy(projectId: string, autonomy: Autonomy, db?: DatabaseSync): void`

### `./direction.js`

- **`parseDirection`**
  - Signature: `function parseDirection(content: string): Direction`
- **`validateDirection`**
  - Signature: `function validateDirection(dir: Partial<Direction>): DirectionValidation`

### `./direction.js`

- **`Direction`**
  - Signature: `type Direction = Direction`
- **`DirectionPhase`**
  - Signature: `type DirectionPhase = DirectionPhase`
- **`DirectionConstraints`**
  - Description: Clawforce — DIRECTION.md schema and loader Parses a DIRECTION.md file (YAML or plain text) into a structured Direction object that drives team setup and manager behavior.
  - Signature: `type DirectionConstraints = DirectionConstraints`
- **`Autonomy`**
  - Signature: `type Autonomy = Autonomy`

### `./templates/startup.js`

- **`getTemplate`**
  - Signature: `function getTemplate(name: string): TemplateDefinition | null`
- **`STARTUP_TEMPLATE`**
  - Signature: `const STARTUP_TEMPLATE: TemplateDefinition`

### `./templates/startup.js`

- **`TemplateDefinition`**
  - Signature: `type TemplateDefinition = TemplateDefinition`

### `./context/observed-events.js`

- **`renderObservedEvents`**
  - Description: Render observed events matching the given patterns as markdown.
  - Signature: `function renderObservedEvents(domain: string, patterns: string[], since: number, db?: DatabaseSync): string`

## Telemetry

### `./telemetry/session-archive.js`

- **`archiveSession`**
  - Description: Create a session archive entry with compressed transcript and context.
  - Signature: `function archiveSession(params: SessionArchiveParams, dbOverride?: DatabaseSync): SessionArchive`
- **`getSessionArchive`**
  - Description: Retrieve a session archive with decompressed fields.
  - Signature: `function getSessionArchive(projectId: string, sessionKey: string, dbOverride?: DatabaseSync): SessionArchive | null`
- **`listSessionArchives`**
  - Description: List session archives with optional filters and pagination.
  - Signature: `function listSessionArchives(projectId: string, filters?: SessionArchiveFilters, dbOverride?: DatabaseSync): SessionArchive[]`

### `./telemetry/session-archive.js`

- **`SessionArchive`**
  - Signature: `type SessionArchive = SessionArchive`
- **`SessionArchiveParams`**
  - Signature: `type SessionArchiveParams = SessionArchiveParams`
- **`SessionArchiveFilters`**
  - Signature: `type SessionArchiveFilters = SessionArchiveFilters`

### `./telemetry/tool-capture.js`

- **`flushToolCallDetails`**
  - Description: Batch insert tool call details from the in-memory buffer. Called at session end to persist all captured tool calls.
  - Signature: `function flushToolCallDetails(sessionKey: string, projectId: string, agentId: string, toolCalls: ToolCallDetail[], taskId?: string, dbOverride?: DatabaseSync): number`
- **`getToolCallDetails`**
  - Description: Retrieve all tool call details for a session, ordered by sequence.
  - Signature: `function getToolCallDetails(projectId: string, sessionKey: string, dbOverride?: DatabaseSync): ToolCallDetailRow[]`

### `./telemetry/tool-capture.js`

- **`ToolCallDetail`**
  - Signature: `type ToolCallDetail = ToolCallDetail`
- **`ToolCallDetailRow`**
  - Signature: `type ToolCallDetailRow = ToolCallDetailRow`

### `./telemetry/config-tracker.js`

- **`detectConfigChange`**
  - Description: Detect if config content has changed since the last recorded version. If changed, creates a new config_version record. Returns the config_version_id (new or existing).
  - Signature: `function detectConfigChange(projectId: string, contextContent: string, detectedBy?: string, dbOverride?: DatabaseSync): string`
- **`getConfigVersion`**
  - Description: Retrieve a specific config version with decompressed content.
  - Signature: `function getConfigVersion(projectId: string, versionId: string, dbOverride?: DatabaseSync): ConfigVersion | null`
- **`getConfigHistory`**
  - Description: List config version history for a project.
  - Signature: `function getConfigHistory(projectId: string, since?: number, dbOverride?: DatabaseSync): ConfigVersion[]`

### `./telemetry/config-tracker.js`

- **`ConfigVersion`**
  - Signature: `type ConfigVersion = ConfigVersion`

### `./telemetry/review-store.js`

- **`recordReview`**
  - Description: Record a manager review for a task.
  - Signature: `function recordReview(params: ReviewParams, dbOverride?: DatabaseSync): ManagerReview`
- **`getReviewsForTask`**
  - Description: Get all reviews for a specific task.
  - Signature: `function getReviewsForTask(projectId: string, taskId: string, dbOverride?: DatabaseSync): ManagerReview[]`
- **`getReviewStats`**
  - Description: Get aggregate review statistics for a project.
  - Signature: `function getReviewStats(projectId: string, dbOverride?: DatabaseSync): ReviewStats`

### `./telemetry/review-store.js`

- **`ReviewParams`**
  - Signature: `type ReviewParams = ReviewParams`
- **`ManagerReview`**
  - Signature: `type ManagerReview = ManagerReview`
- **`ReviewStats`**
  - Signature: `type ReviewStats = ReviewStats`

### `./telemetry/trust-history.js`

- **`snapshotTrustScore`**
  - Description: Insert a trust score snapshot.
  - Signature: `function snapshotTrustScore(params: TrustSnapshotParams, dbOverride?: DatabaseSync): TrustSnapshot`
- **`getTrustTimeline`**
  - Description: Get trust score timeline for a project, optionally filtered by agent.
  - Signature: `function getTrustTimeline(projectId: string, agentId?: string, since?: number, dbOverride?: DatabaseSync): TrustSnapshot[]`

### `./telemetry/trust-history.js`

- **`TrustSnapshotParams`**
  - Signature: `type TrustSnapshotParams = TrustSnapshotParams`
- **`TrustSnapshot`**
  - Signature: `type TrustSnapshot = TrustSnapshot`

## Experiments

### `./experiments/lifecycle.js`

- **`createExperiment`**
  - Signature: `function createExperiment(projectId: string, params: CreateExperimentParams, db?: DatabaseSync): Experiment & { variants: ExperimentVariant[]; }`
- **`startExperiment`**
  - Signature: `function startExperiment(projectId: string, experimentId: string, db?: DatabaseSync): Experiment`
- **`pauseExperiment`**
  - Signature: `function pauseExperiment(projectId: string, experimentId: string, db?: DatabaseSync): Experiment`
- **`completeExperiment`**
  - Signature: `function completeExperiment(projectId: string, experimentId: string, winnerVariantId?: string, db?: DatabaseSync): Experiment`
- **`killExperiment`**
  - Signature: `function killExperiment(projectId: string, experimentId: string, db?: DatabaseSync): Experiment`
- **`getExperiment`**
  - Signature: `function getExperiment(projectId: string, experimentId: string, db?: DatabaseSync): (Experiment & { variants: ExperimentVariant[]; }) | null`
- **`listExperiments`**
  - Signature: `function listExperiments(projectId: string, state?: ExperimentState, db?: DatabaseSync): Experiment[]`

### `./experiments/lifecycle.js`

- **`CreateExperimentParams`**
  - Signature: `type CreateExperimentParams = CreateExperimentParams`

### `./experiments/config.js`

- **`mergeVariantConfig`**
  - Description: Merge a variant's config overrides onto a base agent config. Strategy: - persona: replaces if specified - briefing: replaces if specified (not appended) - exclude_briefing: replaces if specified - expectations: replaces if specified (not merged) - performance_policy: replaces if specified - model: stored in metadata (AgentConfig has no model field) - context_overrides: stored in metadata
  - Signature: `function mergeVariantConfig(baseConfig: AgentConfig, variant: VariantConfig): AgentConfig`

### `./experiments/assignment.js`

- **`assignVariant`**
  - Signature: `function assignVariant(experimentId: string, sessionKey: string, context: AssignmentContext, db?: DatabaseSync): { variantId: string; variant: ExperimentVariant; }`
- **`getActiveExperimentForProject`**
  - Signature: `function getActiveExperimentForProject(projectId: string, db?: DatabaseSync): { experimentId: string; assignmentStrategy: any; } | null`

### `./experiments/assignment.js`

- **`AssignmentContext`**
  - Signature: `type AssignmentContext = AssignmentContext`

### `./experiments/results.js`

- **`recordExperimentOutcome`**
  - Signature: `function recordExperimentOutcome(experimentId: string, variantId: string, sessionKey: string, outcome: ExperimentOutcome, db?: DatabaseSync): void`
- **`getExperimentResults`**
  - Description: Compute per-variant aggregations and determine the winner. Winner logic: highest compliance rate, then lowest avg cost, then fastest avg duration.
  - Signature: `function getExperimentResults(projectId: string, experimentId: string, db?: DatabaseSync): ExperimentResults`

### `./experiments/results.js`

- **`VariantResult`**
  - Signature: `type VariantResult = VariantResult`
- **`ExperimentResults`**
  - Signature: `type ExperimentResults = ExperimentResults`

### `./experiments/canary.js`

- **`checkCanaryHealth`**
  - Signature: `function checkCanaryHealth(experimentId: string, db?: DatabaseSync): CanaryAction`

### `./experiments/canary.js`

- **`CanaryAction`**
  - Signature: `type CanaryAction = CanaryAction`

### `./experiments/validation.js`

- **`validateExperimentConfig`**
  - Description: Validate an experiment configuration before creation. Throws an error with all validation issues if any are found.
  - Signature: `function validateExperimentConfig(projectId: string, experiment: ExperimentConfigInput, db?: DatabaseSync): void`

### `./experiments/validation.js`

- **`ValidationError`**
  - Signature: `type ValidationError = ValidationError`
- **`ExperimentConfigInput`**
  - Signature: `type ExperimentConfigInput = ExperimentConfigInput`

## Verification Gates

### `./verification/runner.js`

- **`runVerificationGates`**
  - Description: Run a set of verification gates sequentially. Stops if total timeout is exceeded.
  - Signature: `function runVerificationGates(gates: VerificationGate[], workingDir: string, options?: { totalTimeoutMs?: number; }): VerificationRunResult`
- **`formatGateResults`**
  - Description: Format gate results as a readable markdown report.
  - Signature: `function formatGateResults(result: VerificationRunResult): string`

### `./verification/runner.js`

- **`GateResult`**
  - Signature: `type GateResult = GateResult`
- **`VerificationRunResult`**
  - Signature: `type VerificationRunResult = VerificationRunResult`

### `./verification/git.js`

- **`generateBranchName`**
  - Description: Generate a branch name from a task ID and optional pattern.
  - Signature: `function generateBranchName(taskId: string, pattern?: string): string`
- **`createTaskBranch`**
  - Description: Create a new branch for a task, checked out from a base branch.
  - Signature: `function createTaskBranch(projectDir: string, taskId: string, baseBranch?: string, pattern?: string): { ok: boolean; branchName?: string; error?: string; }`
- **`mergeTaskBranch`**
  - Description: Merge a task branch back into the base branch with --no-ff. Aborts the merge and returns conflicted=true on conflict.
  - Signature: `function mergeTaskBranch(projectDir: string, branchName: string, baseBranch?: string): { ok: boolean; conflicted: boolean; error?: string; }`
- **`deleteTaskBranch`**
  - Description: Force-delete a task branch.
  - Signature: `function deleteTaskBranch(projectDir: string, branchName: string): { ok: boolean; error?: string; }`
- **`discardTaskBranch`**
  - Description: Discard a task branch: check out the base branch, then delete the task branch.
  - Signature: `function discardTaskBranch(projectDir: string, branchName: string, baseBranch?: string): { ok: boolean; error?: string; }`

### `./verification/lifecycle.js`

- **`getEffectiveVerificationConfig`**
  - Description: Get the effective verification config for a project, with defaults applied.
  - Signature: `function getEffectiveVerificationConfig(projectId: string): VerificationConfig & { enabled: boolean; }`
- **`runVerificationIfConfigured`**
  - Description: Run verification gates if the project has them configured and enabled. Returns null if verification is not configured or no gates are defined.
  - Signature: `function runVerificationIfConfigured(projectId: string, projectDir: string | undefined): { result: VerificationRunResult; formatted: string; } | null`

### `./types.js`

- **`VerificationConfig`**
  - Signature: `type VerificationConfig = VerificationConfig`
- **`VerificationGate`**
  - Signature: `type VerificationGate = VerificationGate`
- **`GitIsolationConfig`**
  - Signature: `type GitIsolationConfig = GitIsolationConfig`

## Dispatch Gate

### `./dispatch/dispatcher.js`

- **`shouldDispatch`**
  - Description: Pre-dispatch gate: checks multi-window budget and provider rate limits. Call this before dispatching an agent session to ensure resource availability.
  - Signature: `function shouldDispatch(projectId: string, agentId: string, provider?: string, options?: { taskId?: string; }): { ok: true; } | { ok: false; reason: string; }`

### `./dispatch/restart-recovery.js`

- **`recoverProject`**
  - Description: Run all recovery steps for a project after gateway restart.
  - Signature: `function recoverProject(projectId: string, dbOverride?: DatabaseSync): RecoveryResult`
- **`releaseStaleInProgressTasks`**
  - Description: Release tasks stuck in IN_PROGRESS with no backing session. After a restart, all sessions are dead — any IN_PROGRESS task is orphaned.
  - Signature: `function releaseStaleInProgressTasks(projectId: string, dbOverride?: DatabaseSync): number`
- **`failStaleDispatchItems`**
  - Description: Fail dispatch queue items that were in "dispatched" or "leased" state before the gateway restart. These items will never receive a response.
  - Signature: `function failStaleDispatchItems(projectId: string, dbOverride?: DatabaseSync): number`
- **`releaseExpiredAssignedLeases`**
  - Description: Release expired leases on ASSIGNED tasks. These tasks were leased to an agent that never started working.
  - Signature: `function releaseExpiredAssignedLeases(projectId: string, dbOverride?: DatabaseSync): number`

## Dashboard

### `./dashboard/index.js`

- **`createDashboardServer`**
  - Signature: _Type-only or unresolved export in declaration file_
- **`handleRequest`**
  - Signature: _Type-only or unresolved export in declaration file_

### `./dashboard/index.js`

- **`DashboardOptions`**
  - Signature: _Type-only or unresolved export in declaration file_

## Database

### `./db.js`

- **`getDb`**
  - Signature: `function getDb(projectId: string): DatabaseSync`
- **`getMemoryDb`**
  - Description: Open an in-memory database for tests.
  - Signature: `function getMemoryDb(): DatabaseSync`
- **`closeDb`**
  - Signature: `function closeDb(projectId: string): void`
- **`closeAllDbs`**
  - Signature: `function closeAllDbs(): void`
- **`setProjectsDir`**
  - Signature: `function setProjectsDir(dir: string): void`
- **`getProjectsDir`**
  - Signature: `function getProjectsDir(): string`
- **`validateProjectId`**
  - Description: Validate a project ID to prevent path traversal and other filesystem issues. Allows alphanumeric, dots, hyphens, and underscores. Max 64 chars.
  - Signature: `function validateProjectId(projectId: string): void`
- **`getDbByDomain`**
  - Signature: `function getDbByDomain(domainId: string): DatabaseSync`
- **`setDataDir`**
  - Signature: `function setDataDir(dir: string): void`
- **`getDataDir`**
  - Signature: `function getDataDir(): string`

