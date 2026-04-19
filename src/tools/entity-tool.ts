/**
 * Clawforce — Entity lifecycle tool
 *
 * Provides agents with managed access to config-defined governed objects.
 */

import { Type } from "@sinclair/typebox";
import {
  clearEntityCheckRuns,
  collectEntityExperimentSnapshot,
  replayWorkflowMutationImplementationTask,
  reopenEntityIssue,
  resetIssueRemediationTasks,
  shapeEntityExperimentSnapshot,
} from "../entities/admin.js";
import { listEntityCheckRuns, runEntityChecks } from "../entities/checks.js";
import { stringEnum } from "../schema-helpers.js";
import {
  createEntity,
  getChildEntities,
  getEntity,
  getEntityIssue,
  getEntityTransitions,
  listEntities,
  listEntityIssues,
  listEntityKinds,
  recordEntityIssue,
  requestEntityTransition,
  resolveEntityIssue,
  summarizeEntityIssues,
  updateEntity,
} from "../entities/ops.js";
import type { EntityIssueSeverity, EntityIssueStatus } from "../types.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, resolveProjectId, safeExecute } from "./common.js";

const ENTITY_ACTIONS = [
  "kinds",
  "create",
  "update",
  "transition",
  "get",
  "list",
  "children",
  "history",
  "issues",
  "report_issue",
  "resolve_issue",
  "run_checks",
  "check_runs",
  "snapshot",
  "reopen_issue",
  "replay_workflow_mutation",
  "reset_remediation",
  "clear_check_runs",
] as const;

const ClawforceEntitySchema = Type.Object({
  action: stringEnum(ENTITY_ACTIONS, { description: "Action to perform on entity lifecycle state." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier." })),
  entity_id: Type.Optional(Type.String({ description: "Entity instance ID." })),
  kind: Type.Optional(Type.String({ description: "Entity kind name configured for the domain." })),
  title: Type.Optional(Type.String({ description: "Entity title." })),
  state: Type.Optional(Type.String({ description: "Entity lifecycle state." })),
  health: Type.Optional(Type.String({ description: "Operational health value." })),
  owner_agent_id: Type.Optional(Type.String({ description: "Agent responsible for the entity." })),
  parent_entity_id: Type.Optional(Type.String({ description: "Parent entity ID." })),
  department: Type.Optional(Type.String({ description: "Department grouping." })),
  team: Type.Optional(Type.String({ description: "Team subgroup." })),
  reason: Type.Optional(Type.String({ description: "Reason for a transition when required." })),
  issue_id: Type.Optional(Type.String({ description: "Entity issue ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID." })),
  issue_key: Type.Optional(Type.String({ description: "Stable issue key used for upsert semantics." })),
  issue_type: Type.Optional(Type.String({ description: "App-defined issue type identifier." })),
  source: Type.Optional(Type.String({ description: "Source system or check that produced the issue." })),
  severity: Type.Optional(Type.String({ description: "Issue severity: low, medium, high, critical." })),
  status: Type.Optional(Type.String({ description: "Issue status filter or resolution target." })),
  check_id: Type.Optional(Type.String({ description: "Configured entity check identifier." })),
  field_name: Type.Optional(Type.String({ description: "Domain field implicated by the issue." })),
  evidence: Type.Optional(Type.Any({ description: "Structured evidence payload for the issue." })),
  recommended_action: Type.Optional(Type.String({ description: "Recommended remediation or operator action." })),
  playbook: Type.Optional(Type.String({ description: "Playbook or workflow identifier for remediation." })),
  check_ids: Type.Optional(Type.Array(Type.String({ description: "Specific configured check IDs to run." }))),
  limit: Type.Optional(Type.Number({ description: "Max results for list queries." })),
  last_verified_at: Type.Optional(Type.Number({ description: "Unix timestamp ms for the most recent verification." })),
  metadata: Type.Optional(Type.Any({ description: "Freeform metadata object validated against the entity kind schema." })),
  clear_parent: Type.Optional(Type.Boolean({ description: "Clear the current parent relationship on update." })),
  full: Type.Optional(Type.Boolean({ description: "Return the full snapshot including raw evidence, payloads, and resolved issues." })),
  include_resolved: Type.Optional(Type.Boolean({ description: "Include resolved issues in snapshot output." })),
}) ;

function readMetadataParam(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = params.metadata;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be an object");
  }
  return value as Record<string, unknown>;
}

function readIssueSeverity(params: Record<string, unknown>): EntityIssueSeverity | undefined {
  const value = readStringParam(params, "severity");
  if (!value) return undefined;
  return value as EntityIssueSeverity;
}

function readIssueStatus(params: Record<string, unknown>): EntityIssueStatus | undefined {
  const value = readStringParam(params, "status");
  if (!value) return undefined;
  return value as EntityIssueStatus;
}

export function createClawforceEntityTool(options?: {
  agentSessionKey?: string;
  projectId?: string;
}) {
  return {
    label: "Entity Lifecycle",
    name: "clawforce_entity",
    description: [
      "Manage config-defined governed objects such as jurisdictions, markets, datasets, or integrations.",
      "",
      "Actions:",
      "  kinds — List configured entity kinds and their lifecycle options",
      "  create — Create a new entity instance",
      "  update — Update ownership, parent, metadata, or verification timestamps",
      "  transition — Change state and/or health with transition validation",
      "  get — Fetch one entity",
      "  list — List entities with filters",
      "  children — List direct child entities",
      "  history — Show entity transition history",
      "  issues — List or fetch entity issues",
      "  report_issue — Upsert an issue linked to an entity",
      "  resolve_issue — Resolve or dismiss an entity issue",
      "  run_checks — Execute configured entity checks and reconcile issues",
      "  check_runs — List recent entity check runs",
      "  snapshot — Capture a dogfood experiment snapshot for an entity",
      "  reopen_issue — Reopen a resolved or dismissed entity issue",
      "  replay_workflow_mutation — Create or reuse a successor workflow-mutation implementation task",
      "  reset_remediation — Cancel and recreate reactive remediation tasks",
      "  clear_check_runs — Clear stored check-run history for a clean experiment boundary",
    ].join("\n"),
    parameters: ClawforceEntitySchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const resolved = resolveProjectId(params, options?.projectId);
        if (resolved.error) return jsonResult({ ok: false, reason: resolved.error });
        const projectId = resolved.projectId!;
        const actor = options?.agentSessionKey ?? "unknown";

        switch (action) {
          case "kinds":
            return jsonResult({ ok: true, kinds: listEntityKinds(projectId) });

          case "create": {
            const kind = readStringParam(params, "kind", { required: true })!;
            const title = readStringParam(params, "title", { required: true })!;
            const entity = createEntity({
              projectId,
              kind,
              title,
              state: readStringParam(params, "state") ?? undefined,
              health: readStringParam(params, "health") ?? undefined,
              ownerAgentId: readStringParam(params, "owner_agent_id") ?? undefined,
              parentEntityId: readStringParam(params, "parent_entity_id") ?? undefined,
              department: readStringParam(params, "department") ?? undefined,
              team: readStringParam(params, "team") ?? undefined,
              metadata: readMetadataParam(params),
              lastVerifiedAt: readNumberParam(params, "last_verified_at", { integer: true }) ?? undefined,
              createdBy: actor,
            });
            return jsonResult({ ok: true, entity });
          }

          case "update": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const clearParent = params.clear_parent === true;
            const entity = updateEntity(projectId, entityId, {
              title: readStringParam(params, "title") ?? undefined,
              ownerAgentId: params.owner_agent_id === null ? null : readStringParam(params, "owner_agent_id") ?? undefined,
              parentEntityId: clearParent ? null : (params.parent_entity_id === null ? null : readStringParam(params, "parent_entity_id") ?? undefined),
              department: params.department === null ? null : readStringParam(params, "department") ?? undefined,
              team: params.team === null ? null : readStringParam(params, "team") ?? undefined,
              metadata: readMetadataParam(params),
              lastVerifiedAt: params.last_verified_at === null ? null : readNumberParam(params, "last_verified_at", { integer: true }) ?? undefined,
            }, actor);
            return jsonResult({ ok: true, entity });
          }

          case "transition": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const result = requestEntityTransition({
              projectId,
              entityId,
              toState: readStringParam(params, "state") ?? undefined,
              toHealth: readStringParam(params, "health") ?? undefined,
              reason: readStringParam(params, "reason") ?? undefined,
              metadata: readMetadataParam(params),
              actor,
              sessionKey: options?.agentSessionKey,
            });
            if (result.ok) {
              return jsonResult({ ok: true, entity: result.entity });
            }
            return jsonResult({
              ok: true,
              approvalRequired: true,
              reason: result.reason,
              proposal: result.proposal,
              blockingIssues: result.blockingIssues,
            });
          }

          case "get": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const entity = getEntity(projectId, entityId);
            if (!entity) return jsonResult({ ok: false, reason: `Entity not found: ${entityId}` });
            return jsonResult({
              ok: true,
              entity,
              issueSummary: summarizeEntityIssues(projectId, entityId),
            });
          }

          case "list": {
            const limit = readNumberParam(params, "limit", { integer: true }) ?? 100;
            const parentParam = readStringParam(params, "parent_entity_id");
            const entities = listEntities(projectId, {
              kind: readStringParam(params, "kind") ?? undefined,
              state: readStringParam(params, "state") ?? undefined,
              health: readStringParam(params, "health") ?? undefined,
              ownerAgentId: readStringParam(params, "owner_agent_id") ?? undefined,
              parentEntityId: parentParam === "none" ? null : parentParam ?? undefined,
              department: readStringParam(params, "department") ?? undefined,
              team: readStringParam(params, "team") ?? undefined,
              limit,
            });
            return jsonResult({ ok: true, entities, count: entities.length });
          }

          case "children": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const entities = getChildEntities(projectId, entityId);
            return jsonResult({ ok: true, entities, count: entities.length });
          }

          case "history": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const transitions = getEntityTransitions(projectId, entityId);
            return jsonResult({ ok: true, transitions, count: transitions.length });
          }

          case "issues": {
            const entityId = readStringParam(params, "entity_id");
            const issueId = readStringParam(params, "issue_id");
            if (issueId) {
              const issue = getEntityIssue(projectId, issueId);
              if (!issue) return jsonResult({ ok: false, reason: `Entity issue not found: ${issueId}` });
              return jsonResult({ ok: true, issue });
            }
            const issues = listEntityIssues(projectId, {
              entityId: entityId ?? undefined,
              status: readIssueStatus(params),
              severity: readIssueSeverity(params),
              issueType: readStringParam(params, "issue_type") ?? undefined,
              source: readStringParam(params, "source") ?? undefined,
              limit: readNumberParam(params, "limit", { integer: true }) ?? undefined,
            });
            const issueSummary = entityId ? summarizeEntityIssues(projectId, entityId) : undefined;
            return jsonResult({ ok: true, issues, count: issues.length, issueSummary });
          }

          case "report_issue": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const issue = recordEntityIssue({
              projectId,
              entityId,
              issueKey: readStringParam(params, "issue_key", { required: true })!,
              issueType: readStringParam(params, "issue_type", { required: true })!,
              source: readStringParam(params, "source", { required: true })!,
              title: readStringParam(params, "title", { required: true })!,
              actor,
              checkId: readStringParam(params, "check_id") ?? undefined,
              severity: readIssueSeverity(params),
              description: readStringParam(params, "description") ?? undefined,
              fieldName: readStringParam(params, "field_name") ?? undefined,
              evidence: params.evidence && typeof params.evidence === "object" && !Array.isArray(params.evidence)
                ? params.evidence as Record<string, unknown>
                : undefined,
              recommendedAction: readStringParam(params, "recommended_action") ?? undefined,
              playbook: readStringParam(params, "playbook") ?? undefined,
              ownerAgentId: readStringParam(params, "owner_agent_id") ?? undefined,
            });
            return jsonResult({
              ok: true,
              issue,
              issueSummary: summarizeEntityIssues(projectId, entityId),
            });
          }

          case "resolve_issue": {
            const issueId = readStringParam(params, "issue_id", { required: true })!;
            const issue = resolveEntityIssue({
              projectId,
              issueId,
              actor,
              status: readIssueStatus(params) as "resolved" | "dismissed" | undefined,
            });
            return jsonResult({
              ok: true,
              issue,
              issueSummary: summarizeEntityIssues(projectId, issue.entityId),
            });
          }

          case "run_checks": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const checkIds = Array.isArray(params.check_ids)
              ? params.check_ids.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : undefined;
            const result = runEntityChecks(projectId, entityId, {
              actor,
              trigger: "tool",
              sourceType: "entity_tool",
              sourceId: "run_checks",
              checkIds,
            });
            return jsonResult({
              ok: true,
              entity: result.entity,
              results: result.results,
              issueSummary: summarizeEntityIssues(projectId, entityId),
            });
          }

          case "check_runs": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const limit = readNumberParam(params, "limit", { integer: true }) ?? 20;
            const runs = listEntityCheckRuns(projectId, entityId, limit);
            return jsonResult({ ok: true, runs, count: runs.length });
          }

          case "snapshot": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const rawSnapshot = collectEntityExperimentSnapshot(projectId, entityId, {
              issueLimit: readNumberParam(params, "limit", { integer: true }) ?? undefined,
            });
            const snapshot = shapeEntityExperimentSnapshot(rawSnapshot, {
              full: params.full === true,
              includeResolvedIssues: params.full === true || params.include_resolved === true,
            });
            return jsonResult({ ok: true, snapshot });
          }

          case "reopen_issue": {
            const issueId = readStringParam(params, "issue_id", { required: true })!;
            const issue = reopenEntityIssue({
              projectId,
              issueId,
              actor,
              reason: readStringParam(params, "reason") ?? undefined,
            });
            return jsonResult({
              ok: true,
              issue,
              issueSummary: summarizeEntityIssues(projectId, issue.entityId),
            });
          }

          case "replay_workflow_mutation": {
            const taskId = readStringParam(params, "task_id", { required: true })!;
            const result = replayWorkflowMutationImplementationTask({
              projectId,
              taskId,
              actor,
              reason: readStringParam(params, "reason") ?? undefined,
            });
            return jsonResult({ ok: true, ...result });
          }

          case "reset_remediation": {
            const entityId = readStringParam(params, "entity_id");
            const issueId = readStringParam(params, "issue_id");
            if (!entityId && !issueId) {
              return jsonResult({ ok: false, reason: "reset_remediation requires entity_id or issue_id" });
            }
            const result = resetIssueRemediationTasks({
              projectId,
              actor,
              entityId: entityId ?? undefined,
              issueId: issueId ?? undefined,
              reason: readStringParam(params, "reason") ?? undefined,
            });
            return jsonResult({ ok: true, ...result });
          }

          case "clear_check_runs": {
            const entityId = readStringParam(params, "entity_id", { required: true })!;
            const result = clearEntityCheckRuns({
              projectId,
              entityId,
              actor,
            });
            return jsonResult({ ok: true, ...result });
          }

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}
