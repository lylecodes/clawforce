import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "../sqlite-driver.js";
import { writeAuditEntry } from "../audit.js";
import { getDb } from "../db.js";
import { safeLog } from "../diagnostics.js";
import { evaluateCommandExecution } from "../execution/intercept.js";
import { recordChange } from "../history/store.js";
import { getExtendedProjectConfig, getProjectDir } from "../project.js";
import type {
  Entity,
  EntityCheckConfig,
  EntityCheckParserConfig,
  EntityCheckJsonRecordIssuesParserConfig,
  EntityCheckJsonRecordStatusParserConfig,
  EntityCheckRun,
  EntityCheckRunStatus,
  EntityIssue,
  EntityIssueSeverity,
} from "../types.js";
import {
  getEntity,
  listEntityIssues,
  recordEntityIssue,
  resolveEntityIssue,
  syncEntityHealthFromIssues,
  updateEntity,
} from "./ops.js";
import { reconcileEntityReadiness } from "./lifecycle.js";

type CheckExecutionResult = EntityCheckRun & {
  issues: EntityIssue[];
};

export type RunEntityChecksResult = {
  entity: Entity;
  results: CheckExecutionResult[];
};

type ParsedIssue = {
  issueKey: string;
  issueType: string;
  title: string;
  severity?: EntityIssueSeverity;
  description?: string;
  fieldName?: string;
  evidence?: Record<string, unknown>;
  blocking?: boolean;
  approvalRequired?: boolean;
};

type ParsedCheckOutput = {
  issues: ParsedIssue[];
  metadataUpdates?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getPathValue(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  const normalized = path.trim();
  if (!normalized) return root;
  const parts = normalized.split(".").filter(Boolean);
  let current: unknown = root;
  for (const part of parts) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
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
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, token) => {
    const value = getPathValue(context, String(token).trim());
    return stringifyValue(value);
  });
}

function normalizeSeverity(value: unknown): EntityIssueSeverity | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  if (value === "warning") return "medium";
  if (value === "error") return "high";
  if (value === "info") return "low";
  return undefined;
}

function rowToEntityCheckRun(row: Record<string, unknown>): EntityCheckRun {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    entityId: row.entity_id as string,
    entityKind: row.entity_kind as string,
    checkId: row.check_id as string,
    status: row.status as EntityCheckRunStatus,
    command: row.command as string,
    parserType: (row.parser_type as string) ?? undefined,
    actor: (row.actor as string) ?? undefined,
    trigger: (row.trigger as string) ?? undefined,
    sourceType: (row.source_type as string) ?? undefined,
    sourceId: (row.source_id as string) ?? undefined,
    exitCode: row.exit_code as number,
    issueCount: row.issue_count as number,
    stdout: (row.stdout as string) ?? undefined,
    stderr: (row.stderr as string) ?? undefined,
    durationMs: row.duration_ms as number,
    createdAt: row.created_at as number,
  };
}

function getCheckConfig(projectId: string, entity: Entity, checkId: string): EntityCheckConfig {
  const kindConfig = getExtendedProjectConfig(projectId)?.entities?.[entity.kind];
  const check = kindConfig?.issues?.checks?.[checkId];
  if (!check) {
    throw new Error(`Entity check "${checkId}" is not configured for kind "${entity.kind}"`);
  }
  return check;
}

function getConfiguredChecks(projectId: string, entity: Entity): Array<{ checkId: string; config: EntityCheckConfig }> {
  const checks = getExtendedProjectConfig(projectId)?.entities?.[entity.kind]?.issues?.checks ?? {};
  return Object.entries(checks).map(([checkId, config]) => ({ checkId, config }));
}

function getWorkingDir(projectId: string): string {
  const projectDir = getProjectDir(projectId);
  if (!projectDir) {
    throw new Error(`Project "${projectId}" does not have a registered working directory`);
  }
  return projectDir;
}

function parseJsonOutput(stdout: string, stderr: string, checkId: string): unknown {
  const candidate = stdout.trim() || stderr.trim();
  if (!candidate) {
    throw new Error(`Entity check "${checkId}" produced no JSON output`);
  }
  try {
    return JSON.parse(candidate);
  } catch (err) {
    const lineStartIndexes: number[] = [];
    for (let index = 0; index < candidate.length; index++) {
      const current = candidate[index];
      const previous = index === 0 ? "\n" : candidate[index - 1];
      if ((current === "{" || current === "[") && previous === "\n") {
        lineStartIndexes.push(index);
      }
    }

    for (let i = lineStartIndexes.length - 1; i >= 0; i--) {
      const jsonCandidate = candidate.slice(lineStartIndexes[i]!).trim();
      try {
        return JSON.parse(jsonCandidate);
      } catch {
        // Keep walking backward until we find a valid document boundary.
      }
    }

    throw new Error(`Entity check "${checkId}" returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function findMatchingRecord(
  parser: Extract<EntityCheckParserConfig, { type: "json_record_issues" | "json_record_status" }>,
  output: unknown,
  entity: Entity,
  checkId: string,
): Record<string, unknown> {
  const records = getPathValue(output, parser.recordsPath);
  if (!Array.isArray(records)) {
    throw new Error(`Entity check "${checkId}" parser.recordsPath did not resolve to an array`);
  }
  const matchValue = parser.matchValueTemplate
    ? renderTemplate(parser.matchValueTemplate, { entity, check: { id: checkId } })
    : entity.title;
  const record = records.find((item) => stringifyValue(getPathValue(item, parser.matchField)) === matchValue);
  if (!record) {
    throw new Error(`Entity check "${checkId}" did not find a record matching "${matchValue}"`);
  }
  const parsed = asRecord(record);
  if (!parsed) {
    throw new Error(`Entity check "${checkId}" matched a non-object record`);
  }
  return parsed;
}

function buildMetadataUpdates(record: Record<string, unknown>, metadataUpdates: Record<string, string> | undefined): Record<string, unknown> | undefined {
  if (!metadataUpdates) return undefined;
  const updates = Object.fromEntries(
    Object.entries(metadataUpdates).map(([key, path]) => [key, getPathValue(record, path)]),
  );
  return Object.keys(updates).length > 0 ? updates : undefined;
}

function buildFallbackIssueKey(
  checkId: string,
  issueType: string,
  fieldName: string | undefined,
  title: string,
): string {
  return [checkId, issueType, fieldName ?? title]
    .map((value) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"))
    .filter(Boolean)
    .join(":");
}

function parseJsonRecordIssues(
  parser: Extract<EntityCheckParserConfig, { type: "json_record_issues" }>,
  output: unknown,
  entity: Entity,
  checkId: string,
): ParsedCheckOutput {
  const record = findMatchingRecord(parser, output, entity, checkId);
  const issueItems = getPathValue(record, parser.issueArrayPath);
  if (!Array.isArray(issueItems)) {
    throw new Error(`Entity check "${checkId}" parser.issueArrayPath did not resolve to an array`);
  }

  const issues = issueItems.map((item, index) => {
    const issueRecord = asRecord(item);
    if (!issueRecord) {
      throw new Error(`Entity check "${checkId}" issue entry ${index} is not an object`);
    }
    const rawIssueType = parser.issueTypeField ? stringifyValue(getPathValue(issueRecord, parser.issueTypeField)) : "";
    const issueType = (rawIssueType && parser.issueTypeMap?.[rawIssueType])
      ?? rawIssueType
      ?? parser.defaultIssueType
      ?? "system:check_output";
    const title = parser.titleField
      ? stringifyValue(getPathValue(issueRecord, parser.titleField))
      : stringifyValue(getPathValue(issueRecord, "message"));
    if (!title) {
      throw new Error(`Entity check "${checkId}" issue entry ${index} did not resolve a title`);
    }
    const fieldName = parser.fieldNameField
      ? stringifyValue(getPathValue(issueRecord, parser.fieldNameField))
      : undefined;
    const description = parser.descriptionTemplate
      ? renderTemplate(parser.descriptionTemplate, { entity, record, issue: issueRecord, check: { id: checkId } })
      : parser.descriptionField
        ? stringifyValue(getPathValue(issueRecord, parser.descriptionField))
        : undefined;
    const issueKey = parser.keyTemplate
      ? renderTemplate(parser.keyTemplate, { entity, record, issue: issueRecord, check: { id: checkId } })
      : buildFallbackIssueKey(checkId, issueType, fieldName, title);
    return {
      issueKey,
      issueType,
      title,
      severity: normalizeSeverity(parser.severityField ? getPathValue(issueRecord, parser.severityField) : getPathValue(issueRecord, "severity")),
      description,
      fieldName,
      evidence: {
        record,
        issue: issueRecord,
      },
    } satisfies ParsedIssue;
  });

  return {
    issues,
    metadataUpdates: buildMetadataUpdates(record, parser.metadataUpdates),
  };
}

function parseJsonRecordStatus(
  parser: Extract<EntityCheckParserConfig, { type: "json_record_status" }>,
  output: unknown,
  entity: Entity,
  checkId: string,
): ParsedCheckOutput {
  const record = findMatchingRecord(parser, output, entity, checkId);
  const status = stringifyValue(getPathValue(record, parser.statusField));
  const metadataUpdates = buildMetadataUpdates(record, parser.metadataUpdates);

  if (!status || parser.ignoreStatuses?.includes(status)) {
    return { issues: [], metadataUpdates };
  }

  const rule = parser.issueStates[status];
  if (!rule) {
    return { issues: [], metadataUpdates };
  }

  const title = rule.titleTemplate
    ? renderTemplate(rule.titleTemplate, { entity, record, check: { id: checkId, status } })
    : `Entity check ${checkId} reported ${status}`;
  const description = rule.descriptionTemplate
    ? renderTemplate(rule.descriptionTemplate, { entity, record, check: { id: checkId, status } })
    : undefined;
  const issueKey = parser.keyTemplate
    ? renderTemplate(parser.keyTemplate, { entity, record, check: { id: checkId, status } })
    : buildFallbackIssueKey(checkId, rule.issueType, status, title);

  return {
    issues: [{
      issueKey,
      issueType: rule.issueType,
      title,
      severity: rule.severity,
      description,
      blocking: rule.blocking,
      approvalRequired: rule.approvalRequired,
      evidence: { record, status },
    }],
    metadataUpdates,
  };
}

function isJsonRecordIssuesParser(
  parser: Exclude<EntityCheckParserConfig, string>,
): parser is EntityCheckJsonRecordIssuesParserConfig {
  return parser.type === "json_record_issues";
}

function isJsonRecordStatusParser(
  parser: Exclude<EntityCheckParserConfig, string>,
): parser is EntityCheckJsonRecordStatusParserConfig {
  return parser.type === "json_record_status";
}

function parseCheckOutput(
  parserConfig: EntityCheckParserConfig | undefined,
  stdout: string,
  stderr: string,
  entity: Entity,
  checkId: string,
): ParsedCheckOutput {
  if (!parserConfig) {
    return { issues: [] };
  }
  if (typeof parserConfig === "string") {
    throw new Error(`Unsupported entity check parser "${parserConfig}"`);
  }
  const parser = parserConfig;
  const output = parseJsonOutput(stdout, stderr, checkId);

  if (isJsonRecordIssuesParser(parser)) {
    return parseJsonRecordIssues(parser, output, entity, checkId);
  }
  if (isJsonRecordStatusParser(parser)) {
    return parseJsonRecordStatus(parser, output, entity, checkId);
  }
  throw new Error(`Unsupported entity check parser "${String((parser as { type?: unknown }).type ?? "unknown")}"`);
}

function persistCheckRun(
  projectId: string,
  entity: Entity,
  result: Omit<EntityCheckRun, "id" | "projectId" | "entityId" | "entityKind" | "createdAt">,
  db: DatabaseSync,
): EntityCheckRun {
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO entity_check_runs (
      id, project_id, entity_id, entity_kind, check_id, status, command, parser_type,
      actor, trigger, source_type, source_id,
      exit_code, issue_count, stdout, stderr, duration_ms, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    entity.id,
    entity.kind,
    result.checkId,
    result.status,
    result.command,
    result.parserType ?? null,
    result.actor ?? null,
    result.trigger ?? null,
    result.sourceType ?? null,
    result.sourceId ?? null,
    result.exitCode,
    result.issueCount,
    result.stdout ?? null,
    result.stderr ?? null,
    result.durationMs,
    createdAt,
  );
  return {
    id,
    projectId,
    entityId: entity.id,
    entityKind: entity.kind,
    checkId: result.checkId,
    status: result.status,
    command: result.command,
    parserType: result.parserType,
    actor: result.actor,
    trigger: result.trigger,
    sourceType: result.sourceType,
    sourceId: result.sourceId,
    exitCode: result.exitCode,
    issueCount: result.issueCount,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    createdAt,
  };
}

function reconcileCheckIssues(
  projectId: string,
  entityId: string,
  checkId: string,
  activeIssueKeys: Set<string>,
  actor: string,
  db: DatabaseSync,
): void {
  const openIssues = listEntityIssues(projectId, { entityId, status: "open", limit: 1000 }, db)
    .filter((issue) => issue.checkId === checkId);
  for (const issue of openIssues) {
    if (!activeIssueKeys.has(issue.issueKey)) {
      resolveEntityIssue({
        projectId,
        issueId: issue.id,
        actor,
        status: "resolved",
      }, db);
    }
  }
}

function resolveSystemCheckIssues(projectId: string, entityId: string, checkId: string, actor: string, db: DatabaseSync): void {
  const systemIssueTypes = new Set(["system:check_failed", "system:check_parse_failed"]);
  const openIssues = listEntityIssues(projectId, { entityId, status: "open", limit: 1000 }, db)
    .filter((issue) => issue.checkId === checkId && systemIssueTypes.has(issue.issueType));
  for (const issue of openIssues) {
    resolveEntityIssue({ projectId, issueId: issue.id, actor, status: "resolved" }, db);
  }
}

function maybeApplyMetadataUpdates(
  projectId: string,
  entity: Entity,
  metadataUpdates: Record<string, unknown> | undefined,
  actor: string,
  lastVerifiedAt: number,
  db: DatabaseSync,
): Entity {
  const current = getEntity(projectId, entity.id, db) ?? entity;
  if (!metadataUpdates || Object.keys(metadataUpdates).length === 0) {
    return updateEntity(projectId, current.id, {
      lastVerifiedAt,
    }, actor, db);
  }
  const nextMetadata = {
    ...(current.metadata ?? {}),
    ...metadataUpdates,
  };
  return updateEntity(projectId, current.id, {
    metadata: nextMetadata,
    lastVerifiedAt,
  }, actor, db);
}

function createSystemIssue(
  projectId: string,
  entity: Entity,
  checkId: string,
  issueType: "system:check_failed" | "system:check_parse_failed",
  title: string,
  actor: string,
  stderr: string | undefined,
  stdout: string | undefined,
  db: DatabaseSync,
): EntityIssue {
  return recordEntityIssue({
    projectId,
    entityId: entity.id,
    issueKey: `${checkId}:${issueType}`,
    issueType,
    source: checkId,
    checkId,
    title,
    actor,
    severity: "critical",
    description: stderr || stdout || title,
    evidence: {
      stdout,
      stderr,
    },
    blocking: true,
    approvalRequired: false,
  }, db);
}

function executeCheckCommand(command: string, workingDir: string, timeoutMs: number): {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
} {
  const start = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = execSync(command, {
      cwd: workingDir,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    stdout = typeof result === "string" ? result : "";
  } catch (err) {
    const error = err as Record<string, unknown>;
    exitCode = typeof error.status === "number" ? error.status : 1;
    stdout = typeof error.stdout === "string" ? error.stdout : "";
    stderr = typeof error.stderr === "string" ? error.stderr : "";
  }
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
  };
}

function toParserType(parser: EntityCheckParserConfig | undefined): string | undefined {
  if (!parser) return undefined;
  return typeof parser === "string" ? parser : parser.type;
}

export function listEntityCheckRuns(
  projectId: string,
  entityId: string,
  limit = 20,
  dbOverride?: DatabaseSync,
): EntityCheckRun[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(`
    SELECT * FROM entity_check_runs
    WHERE project_id = ? AND entity_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(projectId, entityId, Math.min(limit, 200)) as Record<string, unknown>[];
  return rows.map(rowToEntityCheckRun);
}

export function runEntityChecks(
  projectId: string,
  entityId: string,
  options?: {
    actor?: string;
    trigger?: string;
    sourceType?: string;
    sourceId?: string;
    checkIds?: string[];
    dbOverride?: DatabaseSync;
  },
): RunEntityChecksResult {
  const db = options?.dbOverride ?? getDb(projectId);
  const actor = options?.actor ?? "entity-checks";
  const trigger = options?.trigger ?? "manual";
  const entity = getEntity(projectId, entityId, db);
  if (!entity) throw new Error(`Entity not found: ${entityId}`);
  const workingDir = getWorkingDir(projectId);
  const configuredChecks = getConfiguredChecks(projectId, entity)
    .filter((entry) => !options?.checkIds || options.checkIds.includes(entry.checkId));
  const results: CheckExecutionResult[] = [];

  for (const { checkId, config } of configuredChecks) {
    const renderedCommand = renderTemplate(config.command, {
      entity,
      check: { id: checkId },
      project: { id: projectId, dir: workingDir },
    });
    const timeoutMs = (config.timeoutSeconds ?? 300) * 1000;
    const executionDecision = evaluateCommandExecution(
      {
        projectId,
        actor,
        entityType: entity.kind,
        entityId: entity.id,
        sourceType: "entity_check",
        sourceId: checkId,
        summary: `Would run entity check ${checkId} for ${entity.title}`,
      },
      renderedCommand,
      {
        checkId,
        entityId: entity.id,
        entityKind: entity.kind,
        workingDir,
      },
      db,
    );

    if (executionDecision.effect !== "allow") {
      const run = persistCheckRun(projectId, entity, {
        checkId,
        status: executionDecision.effect === "block" ? "blocked" : "simulated",
        command: renderedCommand,
        parserType: toParserType(config.parser),
        actor,
        trigger,
        sourceType: options?.sourceType,
        sourceId: options?.sourceId,
        exitCode: executionDecision.effect === "block" ? 1 : 0,
        issueCount: 0,
        stdout: undefined,
        stderr: executionDecision.reason,
        durationMs: 0,
      }, db);
      results.push({ ...run, issues: [] });
      continue;
    }

    const execution = executeCheckCommand(renderedCommand, workingDir, timeoutMs);

    try {
      if (execution.exitCode !== 0) {
        const issue = createSystemIssue(
          projectId,
          entity,
          checkId,
          "system:check_failed",
          `Entity check failed: ${checkId}`,
          actor,
          execution.stderr,
          execution.stdout,
          db,
        );
        const run = persistCheckRun(projectId, entity, {
          checkId,
          status: "failed",
          command: renderedCommand,
          parserType: toParserType(config.parser),
          actor,
          trigger,
          sourceType: options?.sourceType,
          sourceId: options?.sourceId,
          exitCode: execution.exitCode,
          issueCount: 1,
          stdout: execution.stdout.slice(-4000) || undefined,
          stderr: execution.stderr.slice(-4000) || undefined,
          durationMs: execution.durationMs,
        }, db);
        results.push({ ...run, issues: [issue] });
        continue;
      }

      const parsed = parseCheckOutput(config.parser, execution.stdout, execution.stderr, entity, checkId);
      const activeKeys = new Set<string>();
      const issues: EntityIssue[] = [];

      for (const parsedIssue of parsed.issues) {
        activeKeys.add(parsedIssue.issueKey);
        issues.push(recordEntityIssue({
          projectId,
          entityId,
          issueKey: parsedIssue.issueKey,
          issueType: parsedIssue.issueType,
          source: checkId,
          sourceType: options?.sourceType,
          sourceId: options?.sourceId,
          checkId,
          title: parsedIssue.title,
          actor,
          severity: parsedIssue.severity,
          description: parsedIssue.description,
          fieldName: parsedIssue.fieldName,
          evidence: parsedIssue.evidence,
          blocking: parsedIssue.blocking,
          approvalRequired: parsedIssue.approvalRequired,
        }, db));
      }

      reconcileCheckIssues(projectId, entityId, checkId, activeKeys, actor, db);
      resolveSystemCheckIssues(projectId, entityId, checkId, actor, db);
      maybeApplyMetadataUpdates(projectId, entity, parsed.metadataUpdates, actor, Date.now(), db);

      const status: EntityCheckRunStatus = issues.length > 0 ? "issues" : "passed";
      const run = persistCheckRun(projectId, entity, {
        checkId,
        status,
        command: renderedCommand,
        parserType: toParserType(config.parser),
        actor,
        trigger,
        sourceType: options?.sourceType,
        sourceId: options?.sourceId,
        exitCode: execution.exitCode,
        issueCount: issues.length,
        stdout: execution.stdout.slice(-4000) || undefined,
        stderr: execution.stderr.slice(-4000) || undefined,
        durationMs: execution.durationMs,
      }, db);
      results.push({ ...run, issues });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeLog("entity.check.parse", err);
      const issue = createSystemIssue(
        projectId,
        entity,
        checkId,
        "system:check_parse_failed",
        `Entity check parse failed: ${checkId}`,
        actor,
        message,
        execution.stdout,
        db,
      );
      const run = persistCheckRun(projectId, entity, {
        checkId,
        status: "failed",
        command: renderedCommand,
        parserType: toParserType(config.parser),
        actor,
        trigger,
        sourceType: options?.sourceType,
        sourceId: options?.sourceId,
        exitCode: execution.exitCode === 0 ? 1 : execution.exitCode,
        issueCount: 1,
        stdout: execution.stdout.slice(-4000) || undefined,
        stderr: message.slice(-4000),
        durationMs: execution.durationMs,
      }, db);
      results.push({ ...run, issues: [issue] });
    }
  }

  try {
    writeAuditEntry({
      projectId,
      actor,
      action: "entity.check.run",
      targetType: "entity",
      targetId: entity.id,
      detail: `${results.length} checks`,
    }, db);
  } catch (err) {
    safeLog("entity.check.audit", err);
  }

  try {
    recordChange(projectId, {
      resourceType: "entity",
      resourceId: entity.id,
      action: "update",
      provenance: "human",
      actor,
      after: getEntity(projectId, entity.id, db) ?? entity,
      reversible: false,
    }, db);
  } catch (err) {
    safeLog("entity.check.history", err);
  }

  try {
    syncEntityHealthFromIssues(projectId, entity.id, db);
  } catch (err) {
    safeLog("entity.check.health", err);
  }

  try {
    reconcileEntityReadiness(projectId, entity.id, actor, db);
  } catch (err) {
    safeLog("entity.check.readiness", err);
  }

  return {
    entity: getEntity(projectId, entity.id, db) ?? entity,
    results,
  };
}
