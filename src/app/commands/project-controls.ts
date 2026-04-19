import { writeAuditEntry } from "../../audit.js";
import { writeDomainContextFile, ContextFileError } from "../queries/context-files.js";
import { getDb } from "../../db.js";
import { ingestEvent } from "../../events/store.js";

export type ProjectCommandResult = {
  status: number;
  body: unknown;
};

export function setProjectBudgetLimit(
  projectId: string,
  newLimitCents: number,
  actor = "dashboard:api",
): {
  ok: true;
  previousLimit: number | null;
  newLimit: number;
} {
  const db = getDb(projectId);
  const now = Date.now();

  const existing = db.prepare(
    "SELECT id, daily_limit_cents FROM budgets WHERE project_id = ? AND agent_id IS NULL",
  ).get(projectId) as { id: string; daily_limit_cents: number | null } | undefined;

  const previousLimit = existing?.daily_limit_cents ?? null;

  if (existing?.id) {
    db.prepare(
      "UPDATE budgets SET daily_limit_cents = ?, updated_at = ? WHERE id = ?",
    ).run(newLimitCents, now, existing.id);
  } else {
    db.prepare(
      `INSERT INTO budgets (
        id, project_id, agent_id,
        daily_limit_cents, daily_spent_cents, daily_reset_at,
        created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 0, ?, ?, ?)`,
    ).run(`budget-project-${now}`, projectId, newLimitCents, now + 86_400_000, now, now);
  }

  writeAuditEntry({
    projectId,
    actor,
    action: "budget.update_limit",
    targetType: "budget",
    targetId: "project",
    detail: JSON.stringify({ previousLimit, newLimit: newLimitCents }),
  }, db);

  return {
    ok: true,
    previousLimit,
    newLimit: newLimitCents,
  };
}

export function runUpdateProjectBudgetLimitCommand(
  projectId: string,
  input: Record<string, unknown>,
  actor = "dashboard:api",
): ProjectCommandResult {
  const rawLimit = input.dailyLimitCents;
  if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || !Number.isInteger(rawLimit)) {
    return { status: 400, body: { error: "dailyLimitCents must be an integer number" } };
  }
  if (rawLimit <= 0 || rawLimit > 100_000) {
    return { status: 400, body: { error: "dailyLimitCents must be > 0 and <= 100000" } };
  }
  return {
    status: 200,
    body: setProjectBudgetLimit(projectId, rawLimit, actor),
  };
}

export function runIngestProjectEventCommand(
  projectId: string,
  input: Record<string, unknown>,
): ProjectCommandResult {
  if (typeof input.type !== "string" || input.type.length === 0) {
    return { status: 400, body: { error: "Missing required field: type" } };
  }

  const db = getDb(projectId);
  const result = ingestEvent(
    projectId,
    input.type,
    "webhook",
    (input.payload as Record<string, unknown>) ?? {},
    (input.dedup_key as string) ?? undefined,
    db,
  );

  return {
    status: result.deduplicated ? 200 : 201,
    body: result,
  };
}

export function runWriteProjectContextFileCommand(
  projectId: string,
  input: Record<string, unknown>,
  options: { includeDomainContext?: boolean } = {},
): ProjectCommandResult {
  if (typeof input.path !== "string" || typeof input.content !== "string") {
    return { status: 400, body: { error: "Missing required fields: path, content" } };
  }

  try {
    return {
      status: 200,
      body: writeDomainContextFile(projectId, input.path, input.content, options),
    };
  } catch (error) {
    if (error instanceof ContextFileError) {
      return { status: error.status, body: { error: error.message } };
    }
    return { status: 500, body: { error: "Failed to write context file" } };
  }
}
