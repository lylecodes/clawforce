import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getDb } from "../db.js";
import { getDefaultRuntimeState } from "./default-runtime.js";

const DEFAULT_CONTROLLER_LEASE_MS = 2 * 60 * 1000;
const CONTROLLER_HANDOFF_OWNER_ID = "controller:handoff-pending";
const CONTROLLER_HANDOFF_OWNER_LABEL = "awaiting-controller";
const CONTROLLER_HANDOFF_GENERATION = "handoff-pending";

export type ControllerLease = {
  projectId: string;
  ownerId: string;
  ownerLabel: string;
  purpose: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  generation: string;
  requiredGeneration?: string | null;
  generationRequestedAt?: number | null;
  generationRequestReason?: string | null;
  appliedConfigVersionId?: string | null;
  appliedConfigHash?: string | null;
  appliedConfigAppliedAt?: number | null;
  metadata?: Record<string, unknown> | null;
};

export type AcquireControllerLeaseOptions = {
  ttlMs?: number;
  purpose?: string;
  ownerId?: string;
  ownerLabel?: string;
  generation?: string;
  metadata?: Record<string, unknown>;
};

export type RequestControllerGenerationOptions = {
  generation?: string;
  reason?: string;
  requestedBy?: string;
  metadata?: Record<string, unknown>;
};

export type AcquireControllerLeaseResult =
  | {
    ok: true;
    lease: ControllerLease;
    acquiredNew: boolean;
  }
  | {
    ok: false;
    lease: ControllerLease;
  };

export type WithControllerLeaseOptions = AcquireControllerLeaseOptions & {
  persistent?: boolean;
};

function hasPendingProposalExecutionForGeneration(
  projectId: string,
  generation: string,
  db: DatabaseSync,
): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM proposals
    WHERE project_id = ?
      AND status = 'approved'
      AND execution_status = 'pending'
      AND execution_required_generation = ?
  `).get(projectId, generation) as { count?: number } | undefined;
  return (row?.count ?? 0) > 0;
}

function parseLease(row: Record<string, unknown>): ControllerLease {
  return {
    projectId: row.project_id as string,
    ownerId: row.owner_id as string,
    ownerLabel: row.owner_label as string,
    purpose: row.purpose as string,
    acquiredAt: row.acquired_at as number,
    heartbeatAt: row.heartbeat_at as number,
    expiresAt: row.expires_at as number,
    generation: typeof row.generation === "string" ? row.generation : "legacy",
    requiredGeneration: typeof row.required_generation === "string" ? row.required_generation : null,
    generationRequestedAt: typeof row.generation_requested_at === "number" ? row.generation_requested_at : null,
    generationRequestReason: typeof row.generation_request_reason === "string" ? row.generation_request_reason : null,
    appliedConfigVersionId: typeof row.applied_config_version_id === "string" ? row.applied_config_version_id : null,
    appliedConfigHash: typeof row.applied_config_hash === "string" ? row.applied_config_hash : null,
    appliedConfigAppliedAt: typeof row.applied_config_applied_at === "number" ? row.applied_config_applied_at : null,
    metadata: row.metadata ? JSON.parse(row.metadata as string) as Record<string, unknown> : null,
  };
}

function getControllerInstanceId(): string {
  const runtime = getDefaultRuntimeState();
  if (!runtime.controller.instanceId) {
    runtime.controller.instanceId = crypto.randomUUID();
  }
  return runtime.controller.instanceId;
}

export function getCurrentControllerOwnerId(): string {
  return `controller:${os.hostname()}:${process.pid}:${getControllerInstanceId()}`;
}

export function getCurrentControllerOwnerLabel(): string {
  return `${process.pid}@${os.hostname()}`;
}

function walkGenerationInput(
  targetPath: string,
  baseDir: string,
  hash: crypto.Hash,
): void {
  const stat = fs.statSync(targetPath);
  const relPath = path.relative(baseDir, targetPath) || path.basename(targetPath);

  if (stat.isDirectory()) {
    hash.update(`dir:${relPath}\n`);
    for (const entry of fs.readdirSync(targetPath).sort()) {
      if (entry === ".git" || entry === "node_modules") continue;
      walkGenerationInput(path.join(targetPath, entry), baseDir, hash);
    }
    return;
  }

  hash.update(`file:${relPath}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
}

function computeControllerGeneration(): string {
  const override = process.env.CLAWFORCE_CONTROLLER_GENERATION?.trim();
  if (override) return override;

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const hash = crypto.createHash("sha1");
  const generationInputs = ["package.json", "src", "adapters", "dist"];
  for (const relative of generationInputs) {
    const absolute = path.join(repoRoot, relative);
    if (!fs.existsSync(absolute)) continue;
    walkGenerationInput(absolute, repoRoot, hash);
  }
  return `gen-${hash.digest("hex").slice(0, 12)}`;
}

export function getCurrentControllerGeneration(): string {
  const runtime = getDefaultRuntimeState();
  if (!runtime.controller.generation) {
    runtime.controller.generation = computeControllerGeneration();
  }
  return runtime.controller.generation;
}

export function resetControllerIdentityForTest(): void {
  const runtime = getDefaultRuntimeState();
  runtime.controller.instanceId = null;
  runtime.controller.generation = null;
}

export function getControllerLease(
  projectId: string,
  dbOverride?: DatabaseSync,
): ControllerLease | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare(
    "SELECT * FROM controller_leases WHERE project_id = ?",
  ).get(projectId) as Record<string, unknown> | undefined;
  return row ? parseLease(row) : null;
}

export function markControllerLeaseConfigApplied(
  projectId: string,
  versionId: string,
  contentHash: string,
  options: {
    ownerId?: string;
    appliedAt?: number;
  } = {},
  dbOverride?: DatabaseSync,
): ControllerLease | null {
  const db = dbOverride ?? getDb(projectId);
  const ownerId = options.ownerId ?? getCurrentControllerOwnerId();
  const appliedAt = options.appliedAt ?? Date.now();
  const result = db.prepare(`
    UPDATE controller_leases
    SET applied_config_version_id = ?, applied_config_hash = ?, applied_config_applied_at = ?
    WHERE project_id = ? AND owner_id = ?
  `).run(versionId, contentHash, appliedAt, projectId, ownerId);
  if (Number(result.changes ?? 0) === 0) {
    return null;
  }
  return getControllerLease(projectId, db);
}

export function requestControllerGeneration(
  projectId: string,
  options: RequestControllerGenerationOptions = {},
  dbOverride?: DatabaseSync,
  withinTransaction: boolean = false,
): ControllerLease {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const requiredGeneration = options.generation ?? getCurrentControllerGeneration();
  const metadata = JSON.stringify({
    requestedBy: options.requestedBy ?? getCurrentControllerOwnerId(),
    ...(options.metadata ?? {}),
  });

  if (!withinTransaction) {
    db.prepare("BEGIN IMMEDIATE").run();
  }
  try {
    const row = db.prepare(
      "SELECT * FROM controller_leases WHERE project_id = ?",
    ).get(projectId) as Record<string, unknown> | undefined;

    if (!row) {
      db.prepare(`
        INSERT INTO controller_leases (
          project_id, owner_id, owner_label, purpose, acquired_at, heartbeat_at, expires_at, generation,
          required_generation, generation_requested_at, generation_request_reason, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        CONTROLLER_HANDOFF_OWNER_ID,
        CONTROLLER_HANDOFF_OWNER_LABEL,
        "handoff",
        now,
        now,
        now,
        CONTROLLER_HANDOFF_GENERATION,
        requiredGeneration,
        now,
        options.reason ?? "controller_generation_requested",
        metadata,
      );
    } else {
      db.prepare(`
        UPDATE controller_leases
        SET required_generation = ?, generation_requested_at = ?, generation_request_reason = ?, metadata = ?
        WHERE project_id = ?
      `).run(
        requiredGeneration,
        now,
        options.reason ?? "controller_generation_requested",
        metadata,
        projectId,
      );
    }

    if (!withinTransaction) {
      db.prepare("COMMIT").run();
    }
  } catch (err) {
    if (!withinTransaction) {
      try { db.prepare("ROLLBACK").run(); } catch { /* already rolled back */ }
    }
    throw err;
  }

  const lease = getControllerLease(projectId, db);
  if (!lease) {
    throw new Error(`Failed to persist controller generation requirement for ${projectId}`);
  }
  return lease;
}

export function clearControllerGenerationRequest(
  projectId: string,
  options: {
    generation?: string | null;
  } = {},
  dbOverride?: DatabaseSync,
): ControllerLease | null {
  const db = dbOverride ?? getDb(projectId);
  const current = getControllerLease(projectId, db);
  if (!current?.requiredGeneration) return current;
  if (options.generation && current.requiredGeneration !== options.generation) return current;
  if (hasPendingProposalExecutionForGeneration(projectId, current.requiredGeneration, db)) {
    return current;
  }

  db.prepare(`
    UPDATE controller_leases
    SET required_generation = NULL,
        generation_requested_at = NULL,
        generation_request_reason = NULL
    WHERE project_id = ?
  `).run(projectId);

  return getControllerLease(projectId, db);
}

export function acquireControllerLease(
  projectId: string,
  options: AcquireControllerLeaseOptions = {},
  dbOverride?: DatabaseSync,
): AcquireControllerLeaseResult {
  const db = dbOverride ?? getDb(projectId);
  const now = Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_CONTROLLER_LEASE_MS;
  const ownerId = options.ownerId ?? getCurrentControllerOwnerId();
  const ownerLabel = options.ownerLabel ?? getCurrentControllerOwnerLabel();
  const purpose = options.purpose ?? "controller";
  const generation = options.generation ?? getCurrentControllerGeneration();
  const expiresAt = now + ttlMs;
  const metadata = JSON.stringify(options.metadata ?? {
    pid: process.pid,
    host: os.hostname(),
    cwd: process.cwd(),
  });

  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const row = db.prepare(
      "SELECT * FROM controller_leases WHERE project_id = ?",
    ).get(projectId) as Record<string, unknown> | undefined;

    if (!row) {
      db.prepare(`
        INSERT INTO controller_leases (
          project_id, owner_id, owner_label, purpose, acquired_at, heartbeat_at, expires_at, generation,
          required_generation, generation_requested_at, generation_request_reason, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
      `).run(projectId, ownerId, ownerLabel, purpose, now, now, expiresAt, generation, metadata);
      db.prepare("COMMIT").run();
      return {
        ok: true,
        acquiredNew: true,
        lease: {
          projectId,
          ownerId,
          ownerLabel,
          purpose,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt,
          generation,
          metadata: JSON.parse(metadata) as Record<string, unknown>,
        },
      };
    }

    const current = parseLease(row);
    let effectiveCurrent = current;
    let generationRequested = typeof effectiveCurrent.requiredGeneration === "string" && effectiveCurrent.requiredGeneration.length > 0;
    let generationMatchesRequirement = !generationRequested || effectiveCurrent.requiredGeneration === generation;
    const sameOwner = current.ownerId === ownerId;
    const placeholderOwner = current.ownerId === CONTROLLER_HANDOFF_OWNER_ID;
    const expired = effectiveCurrent.expiresAt <= now;

    if (expired && generationRequested && !generationMatchesRequirement) {
      const cleared = clearControllerGenerationRequest(projectId, {
        generation: effectiveCurrent.requiredGeneration,
      }, db);
      if (cleared) {
        effectiveCurrent = cleared;
        generationRequested = typeof effectiveCurrent.requiredGeneration === "string" && effectiveCurrent.requiredGeneration.length > 0;
        generationMatchesRequirement = !generationRequested || effectiveCurrent.requiredGeneration === generation;
      }
    }

    const canTakeoverForGeneration = generationRequested
      && effectiveCurrent.requiredGeneration === generation
      && effectiveCurrent.generation !== generation;

    if (
      (sameOwner && generationMatchesRequirement)
      || (placeholderOwner && generationMatchesRequirement)
      || (expired && generationMatchesRequirement)
      || canTakeoverForGeneration
    ) {
      const acquiredAt = sameOwner && effectiveCurrent.generation === generation ? effectiveCurrent.acquiredAt : now;
      const nextPurpose = sameOwner && effectiveCurrent.generation === generation ? effectiveCurrent.purpose : purpose;
      const preserveAppliedConfig = sameOwner && effectiveCurrent.generation === generation;
      db.prepare(`
        UPDATE controller_leases
        SET owner_id = ?, owner_label = ?, purpose = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?, generation = ?, metadata = ?,
            applied_config_version_id = ?, applied_config_hash = ?, applied_config_applied_at = ?
        WHERE project_id = ?
      `).run(
        ownerId,
        ownerLabel,
        nextPurpose,
        acquiredAt,
        now,
        expiresAt,
        generation,
        metadata,
        preserveAppliedConfig ? effectiveCurrent.appliedConfigVersionId ?? null : null,
        preserveAppliedConfig ? effectiveCurrent.appliedConfigHash ?? null : null,
        preserveAppliedConfig ? effectiveCurrent.appliedConfigAppliedAt ?? null : null,
        projectId,
      );
      db.prepare("COMMIT").run();
      return {
        ok: true,
        acquiredNew: current.ownerId !== ownerId || current.generation !== generation,
        lease: {
          projectId,
          ownerId,
          ownerLabel,
          purpose: nextPurpose,
          acquiredAt,
          heartbeatAt: now,
          expiresAt,
          generation,
          requiredGeneration: effectiveCurrent.requiredGeneration,
          generationRequestedAt: effectiveCurrent.generationRequestedAt,
          generationRequestReason: effectiveCurrent.generationRequestReason,
          appliedConfigVersionId: preserveAppliedConfig ? effectiveCurrent.appliedConfigVersionId ?? null : null,
          appliedConfigHash: preserveAppliedConfig ? effectiveCurrent.appliedConfigHash ?? null : null,
          appliedConfigAppliedAt: preserveAppliedConfig ? effectiveCurrent.appliedConfigAppliedAt ?? null : null,
          metadata: JSON.parse(metadata) as Record<string, unknown>,
        },
      };
    }

    db.prepare("COMMIT").run();
    return {
      ok: false,
      lease: current,
    };
  } catch (err) {
    try { db.prepare("ROLLBACK").run(); } catch { /* already rolled back */ }
    throw err;
  }
}

export function releaseControllerLease(
  projectId: string,
  ownerId?: string,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const effectiveOwnerId = ownerId ?? getCurrentControllerOwnerId();
  const row = db.prepare(
    "SELECT * FROM controller_leases WHERE project_id = ? AND owner_id = ?",
  ).get(projectId, effectiveOwnerId) as Record<string, unknown> | undefined;
  if (!row) return false;

  const current = parseLease(row);
  if (current.requiredGeneration) {
    const now = Date.now();
    db.prepare(`
      UPDATE controller_leases
      SET owner_id = ?, owner_label = ?, purpose = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?, generation = ?, metadata = ?
      WHERE project_id = ? AND owner_id = ?
    `).run(
      CONTROLLER_HANDOFF_OWNER_ID,
      CONTROLLER_HANDOFF_OWNER_LABEL,
      "handoff",
      now,
      now,
      now,
      current.generation,
      JSON.stringify({
        releasedBy: effectiveOwnerId,
        releasedAt: now,
      }),
      projectId,
      effectiveOwnerId,
    );
    return true;
  }

  const result = db.prepare(
    "DELETE FROM controller_leases WHERE project_id = ? AND owner_id = ?",
  ).run(projectId, effectiveOwnerId);
  return Number(result.changes) > 0;
}

export async function withControllerLease<T>(
  projectId: string,
  work: () => Promise<T>,
  options: WithControllerLeaseOptions = {},
  dbOverride?: DatabaseSync,
): Promise<
  | { skipped: false; lease: ControllerLease; result: T }
  | { skipped: true; lease: ControllerLease }
> {
  const db = dbOverride ?? getDb(projectId);
  const lease = acquireControllerLease(projectId, options, db);
  if (!lease.ok) {
    return {
      skipped: true,
      lease: lease.lease,
    };
  }

  try {
    const result = await work();
    return {
      skipped: false,
      lease: lease.lease,
      result,
    };
  } finally {
    if (!options.persistent && lease.acquiredNew) {
      releaseControllerLease(projectId, lease.lease.ownerId, db);
    }
  }
}
