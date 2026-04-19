import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { getExtendedProjectConfig } from "../project.js";
import type { Entity, EntityIssueStateSignalConfig } from "../types.js";
import { getEntity, listEntityIssues, recordEntityIssue, resolveEntityIssue } from "./ops.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getPathValue(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  const parts = path.trim().split(".").filter(Boolean);
  let current: unknown = root;
  for (const part of parts) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[part];
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, token) =>
    stringifyValue(getPathValue(context, String(token).trim())));
}

function signalMatches(signal: EntityIssueStateSignalConfig, entity: Entity): boolean {
  const stateMatch = !signal.whenStates || signal.whenStates.length === 0 || signal.whenStates.includes(entity.state);
  if (!stateMatch) return false;
  if (signal.ownerPresence === "missing") return !entity.ownerAgentId;
  if (signal.ownerPresence === "present") return Boolean(entity.ownerAgentId);
  return true;
}

function buildIssueKey(signal: EntityIssueStateSignalConfig, entity: Entity): string {
  const context = { entity, signal };
  if (signal.issueKeyTemplate) return renderTemplate(signal.issueKeyTemplate, context);
  if (signal.issueKey) return signal.issueKey;
  return `state-signal:${signal.id ?? signal.issueType}`;
}

function buildSignalTitle(signal: EntityIssueStateSignalConfig, entity: Entity): string {
  if (signal.titleTemplate) {
    return renderTemplate(signal.titleTemplate, { entity, signal });
  }
  return `${entity.title}: ${signal.issueType}`;
}

function buildSignalDescription(signal: EntityIssueStateSignalConfig, entity: Entity): string | undefined {
  if (!signal.descriptionTemplate) return undefined;
  return renderTemplate(signal.descriptionTemplate, { entity, signal });
}

export function reconcileEntityStateSignals(
  projectId: string,
  entityId: string,
  actor = "system:entity-state-signals",
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const entity = getEntity(projectId, entityId, db);
  if (!entity) throw new Error(`Entity not found: ${entityId}`);

  const signals = getExtendedProjectConfig(projectId)?.entities?.[entity.kind]?.issues?.stateSignals ?? [];
  if (signals.length === 0) return;

  const openIssues = listEntityIssues(projectId, {
    entityId,
    status: "open",
    limit: 1000,
  }, db);
  const openByKey = new Map(openIssues.map((issue) => [issue.issueKey, issue]));

  for (const signal of signals) {
    const issueKey = buildIssueKey(signal, entity);
    const matches = signalMatches(signal, entity);

    if (matches) {
      recordEntityIssue({
        projectId,
        entityId,
        issueKey,
        issueType: signal.issueType,
        source: `state_signal:${signal.id ?? signal.issueType}`,
        sourceType: "entity",
        sourceId: entity.id,
        title: buildSignalTitle(signal, entity),
        description: buildSignalDescription(signal, entity),
        recommendedAction: signal.recommendedAction,
        actor,
        severity: signal.severity,
        blocking: signal.blocking,
        approvalRequired: signal.approvalRequired,
        playbook: signal.playbook,
        ownerAgentId: signal.ownerAgentId ?? entity.ownerAgentId,
        evidence: {
          entity: {
            id: entity.id,
            title: entity.title,
            state: entity.state,
            ownerAgentId: entity.ownerAgentId ?? null,
          },
          signal: {
            id: signal.id ?? null,
            whenStates: signal.whenStates ?? [],
            ownerPresence: signal.ownerPresence ?? "any",
          },
        },
      }, db);
      continue;
    }

    const existing = openByKey.get(issueKey);
    if (!existing) continue;
    try {
      resolveEntityIssue({
        projectId,
        issueId: existing.id,
        actor,
        status: "resolved",
      }, db);
    } catch (err) {
      safeLog("entity.stateSignals.resolve", err);
    }
  }
}
