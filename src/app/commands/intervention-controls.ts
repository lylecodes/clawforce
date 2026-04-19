import { getDb } from "../../db.js";

export type InterventionCommandResult = {
  status: number;
  body: unknown;
};

export function runDismissInterventionCommand(
  projectId: string,
  body: Record<string, unknown>,
): InterventionCommandResult {
  const dismissKey = body.dismissKey as string | undefined;
  if (!dismissKey) {
    return { status: 400, body: { error: "Missing dismissKey" } };
  }

  const db = getDb(projectId);
  try {
    const row = db.prepare(
      `SELECT value FROM onboarding_state WHERE project_id = ? AND key = 'dismissed_interventions'`,
    ).get(projectId) as { value: string } | undefined;

    const dismissed: string[] = row ? JSON.parse(row.value) : [];
    if (!dismissed.includes(dismissKey)) {
      dismissed.push(dismissKey);
    }

    db.prepare(
      `INSERT INTO onboarding_state (project_id, key, value, updated_at) VALUES (?, 'dismissed_interventions', ?, ?)
       ON CONFLICT (project_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(projectId, JSON.stringify(dismissed), Date.now());

    return {
      status: 200,
      body: { ok: true, dismissKey, status: "dismissed" },
    };
  } catch (error) {
    return {
      status: 500,
      body: { error: `Failed to dismiss intervention: ${error}` },
    };
  }
}
