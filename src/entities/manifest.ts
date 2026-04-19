import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { DatabaseSync } from "../sqlite-driver.js";
import type { Entity, Task, TaskPriority } from "../types.js";
import { createEntity, listEntities, transitionEntity, updateEntity } from "./ops.js";
import { createTask, linkTaskToEntity, listTasks } from "../tasks/ops.js";

export type EntityManifestTask = {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignedTo?: string;
  department?: string;
  team?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type EntityManifestItem = {
  key: string;
  title: string;
  state?: string;
  health?: string;
  ownerAgentId?: string;
  parentKey?: string | null;
  department?: string;
  team?: string;
  metadata?: Record<string, unknown>;
  tasks?: EntityManifestTask[];
};

export type EntityManifest = {
  version: number;
  kind: string;
  match?: {
    metadataField?: string;
  };
  sync?: {
    preserveState?: boolean;
    preserveHealth?: boolean;
  };
  items: EntityManifestItem[];
};

export type EntityManifestStatusRow = {
  key: string;
  title: string;
  entityId: string | null;
  ownerAgentId: string | null;
  liveState: string | null;
  desiredState: string | null;
  liveHealth: string | null;
  desiredHealth: string | null;
  expectedParentKey: string | null;
  parentKey: string | null;
  tasks: Array<{
    title: string;
    id: string | null;
    state: string | null;
    assignedTo: string | null;
  }>;
};

export type EntityManifestSyncEntry =
  | { action: "created_entity" | "updated_entity"; key: string; entityId: string }
  | { action: "transitioned_entity"; key: string; entityId: string; toState: string | null; toHealth: string | null }
  | { action: "updated_parent"; key: string; entityId: string; parentKey: string | null }
  | { action: "created_task" | "linked_task"; key: string; entityId: string; taskId: string; title: string };

export type EntityManifestSyncResult = {
  manifest: EntityManifest;
  rows: EntityManifestStatusRow[];
  syncReport: EntityManifestSyncEntry[];
};

export type SyncEntityManifestOptions = {
  actor: string;
  applyState?: boolean;
  applyHealth?: boolean;
  transitionReason?: string;
  dbOverride?: DatabaseSync;
};

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function maybeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value as string[]
    : undefined;
}

function normalizeTask(value: unknown, label: string): EntityManifestTask {
  const raw = asObject(value, label);
  const title = maybeString(raw.title);
  if (!title) throw new Error(`${label}.title is required`);
  return {
    title,
    description: maybeString(raw.description),
    priority: maybeString(raw.priority) as TaskPriority | undefined,
    assignedTo: maybeString(raw.assignedTo ?? raw.assigned_to),
    department: maybeString(raw.department),
    team: maybeString(raw.team),
    tags: maybeStringArray(raw.tags),
    metadata: raw.metadata ? asObject(raw.metadata, `${label}.metadata`) : undefined,
  };
}

function normalizeItem(value: unknown, index: number, metadataField: string): EntityManifestItem {
  const label = `items[${index}]`;
  const raw = asObject(value, label);
  const key = maybeString(raw.key ?? raw.slug);
  const title = maybeString(raw.title);
  if (!key) throw new Error(`${label}.key is required`);
  if (!title) throw new Error(`${label}.title is required`);

  const metadata: Record<string, unknown> = raw.metadata ? asObject(raw.metadata, `${label}.metadata`) : {};
  metadata[metadataField] = key;

  const legacyLayer = maybeString(raw.layer);
  if (legacyLayer && metadata.layer === undefined) {
    metadata.layer = legacyLayer;
  }

  const legacyActivationBlockers = maybeStringArray(raw.activationBlockers);
  if (legacyActivationBlockers && metadata.activation_blockers === undefined) {
    metadata.activation_blockers = legacyActivationBlockers;
  }

  const tasksRaw = raw.tasks
    ? asArray(raw.tasks, `${label}.tasks`)
    : raw.kickoffTask
      ? [raw.kickoffTask]
      : [];

  return {
    key,
    title,
    state: maybeString(raw.state),
    health: maybeString(raw.health),
    ownerAgentId: maybeString(raw.ownerAgentId ?? raw.owner_agent_id),
    parentKey: maybeString(raw.parentKey ?? raw.parentSlug ?? raw.parent_key) ?? null,
    department: maybeString(raw.department),
    team: maybeString(raw.team),
    metadata,
    tasks: tasksRaw.map((task, taskIndex) => normalizeTask(task, `${label}.tasks[${taskIndex}]`)),
  };
}

function parseManifestContent(raw: string, sourceLabel: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(raw), sourceLabel);
  } catch {
    const parsed = YAML.parse(raw);
    return asObject(parsed, sourceLabel);
  }
}

export function normalizeEntityManifest(input: unknown): EntityManifest {
  const raw = asObject(input, "manifest");
  const metadataField = maybeString(raw.match && asObject(raw.match, "manifest.match").metadataField) ?? "slug";
  const itemsRaw = raw.items ?? raw.cohort;
  const items = asArray(itemsRaw, "manifest.items");
  const version = typeof raw.version === "number" ? raw.version : 1;
  const kind = maybeString(raw.kind);
  if (!kind) throw new Error("manifest.kind is required");

  const syncRaw = raw.sync ? asObject(raw.sync, "manifest.sync") : {};
  return {
    version,
    kind,
    match: { metadataField },
    sync: {
      preserveState: syncRaw.preserveState === undefined ? true : Boolean(syncRaw.preserveState),
      preserveHealth: syncRaw.preserveHealth === undefined ? true : Boolean(syncRaw.preserveHealth),
    },
    items: items.map((item, index) => normalizeItem(item, index, metadataField)),
  };
}

export function loadEntityManifest(manifestPath: string): EntityManifest {
  const resolvedPath = path.resolve(manifestPath);
  const raw = fs.readFileSync(resolvedPath, "utf8");
  return normalizeEntityManifest(parseManifestContent(raw, resolvedPath));
}

function getItemMetadataKey(item: EntityManifestItem, metadataField: string): string {
  const value = item.metadata?.[metadataField];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Entity manifest item "${item.title}" must define metadata.${metadataField} as a non-empty string`);
  }
  return value;
}

function buildEntityLookup(entities: Entity[], metadataField: string): Map<string, Entity> {
  const map = new Map<string, Entity>();
  for (const entity of entities) {
    const key = entity.metadata?.[metadataField];
    if (typeof key === "string" && key.length > 0) {
      map.set(key, entity);
    }
  }
  return map;
}

function buildTaskRowsForItem(item: EntityManifestItem, entity: Entity | undefined, tasks: Task[]): EntityManifestStatusRow["tasks"] {
  if (!item.tasks || item.tasks.length === 0) return [];
  return item.tasks.map((taskSpec) => {
    const task = entity
      ? tasks.find((candidate) => candidate.entityId === entity.id && candidate.title === taskSpec.title)
      : undefined;
    return {
      title: taskSpec.title,
      id: task?.id ?? null,
      state: task?.state ?? null,
      assignedTo: task?.assignedTo ?? null,
    };
  });
}

export function collectEntityManifestStatus(
  projectId: string,
  manifest: EntityManifest,
  dbOverride?: DatabaseSync,
): EntityManifestStatusRow[] {
  const metadataField = manifest.match?.metadataField ?? "slug";
  const entities = listEntities(projectId, { kind: manifest.kind, limit: 1000 }, dbOverride);
  const tasks = listTasks(projectId, { limit: 1000 }, dbOverride);
  const byKey = buildEntityLookup(entities, metadataField);

  return manifest.items.map((item) => {
    const key = getItemMetadataKey(item, metadataField);
    const entity = byKey.get(key);
    const parentEntity = entity?.parentEntityId
      ? entities.find((candidate) => candidate.id === entity.parentEntityId)
      : undefined;
    const parentKey = parentEntity?.metadata?.[metadataField];
    return {
      key,
      title: item.title,
      entityId: entity?.id ?? null,
      ownerAgentId: entity?.ownerAgentId ?? null,
      liveState: entity?.state ?? null,
      desiredState: item.state ?? null,
      liveHealth: entity?.health ?? null,
      desiredHealth: item.health ?? null,
      expectedParentKey: item.parentKey ?? null,
      parentKey: typeof parentKey === "string" ? parentKey : null,
      tasks: buildTaskRowsForItem(item, entity, tasks),
    };
  });
}

export function syncEntityManifest(
  projectId: string,
  manifest: EntityManifest,
  options: SyncEntityManifestOptions,
): EntityManifestSyncResult {
  const metadataField = manifest.match?.metadataField ?? "slug";
  const preserveState = options.applyState ? false : (manifest.sync?.preserveState ?? true);
  const preserveHealth = options.applyHealth ? false : (manifest.sync?.preserveHealth ?? true);
  const syncReport: EntityManifestSyncEntry[] = [];

  const existingEntities = listEntities(projectId, { kind: manifest.kind, limit: 1000 }, options.dbOverride);
  const byKey = buildEntityLookup(existingEntities, metadataField);

  for (const item of manifest.items) {
    const key = getItemMetadataKey(item, metadataField);
    const existing = byKey.get(key);
    const metadata = { ...(item.metadata ?? {}), [metadataField]: key };

    let entity: Entity;
    if (!existing) {
      entity = createEntity({
        projectId,
        kind: manifest.kind,
        title: item.title,
        state: item.state,
        health: item.health,
        ownerAgentId: item.ownerAgentId,
        department: item.department,
        team: item.team,
        createdBy: options.actor,
        metadata,
      }, options.dbOverride);
      syncReport.push({ action: "created_entity", key, entityId: entity.id });
    } else {
      entity = updateEntity(
        projectId,
        existing.id,
        {
          title: item.title,
          ownerAgentId: item.ownerAgentId ?? undefined,
          department: item.department ?? undefined,
          team: item.team ?? undefined,
          metadata,
        },
        options.actor,
        options.dbOverride,
      );
      syncReport.push({ action: "updated_entity", key, entityId: entity.id });

      const nextState = preserveState ? entity.state : (item.state ?? entity.state);
      const nextHealth = preserveHealth ? entity.health : (item.health ?? entity.health);
      if (nextState !== entity.state || nextHealth !== entity.health) {
        entity = transitionEntity({
          projectId,
          entityId: entity.id,
          toState: nextState,
          toHealth: nextHealth,
          actor: options.actor,
          reason: options.transitionReason,
        }, options.dbOverride);
        syncReport.push({
          action: "transitioned_entity",
          key,
          entityId: entity.id,
          toState: nextState ?? null,
          toHealth: nextHealth ?? null,
        });
      }
    }

    byKey.set(key, entity);
  }

  for (const item of manifest.items) {
    const key = getItemMetadataKey(item, metadataField);
    const entity = byKey.get(key);
    if (!entity) throw new Error(`Entity missing after sync for key "${key}"`);
    const desiredParentId = item.parentKey ? byKey.get(item.parentKey)?.id : undefined;
    if (item.parentKey && !desiredParentId) {
      throw new Error(`Parent key "${item.parentKey}" not found for "${key}"`);
    }
    if ((entity.parentEntityId ?? undefined) !== desiredParentId) {
      const updated = updateEntity(
        projectId,
        entity.id,
        { parentEntityId: desiredParentId ?? null },
        options.actor,
        options.dbOverride,
      );
      byKey.set(key, updated);
      syncReport.push({
        action: "updated_parent",
        key,
        entityId: updated.id,
        parentKey: item.parentKey ?? null,
      });
    }
  }

  const allTasks = listTasks(projectId, { limit: 1000 }, options.dbOverride);
  for (const item of manifest.items) {
    const key = getItemMetadataKey(item, metadataField);
    const entity = byKey.get(key);
    if (!entity || !item.tasks || item.tasks.length === 0) continue;

    for (const taskSpec of item.tasks) {
      const exact = allTasks.find((task) => task.entityId === entity.id && task.title === taskSpec.title);
      if (exact) continue;

      const desiredAssignedTo = taskSpec.assignedTo ?? item.ownerAgentId;
      const unlinked = allTasks.find((task) =>
        task.entityId == null &&
        task.title === taskSpec.title &&
        (desiredAssignedTo ? task.assignedTo === desiredAssignedTo : true),
      );

      if (unlinked) {
        const linked = linkTaskToEntity(projectId, unlinked.id, entity.id, options.dbOverride);
        const existingIndex = allTasks.findIndex((task) => task.id === linked.id);
        if (existingIndex >= 0) allTasks.splice(existingIndex, 1, linked);
        syncReport.push({
          action: "linked_task",
          key,
          entityId: entity.id,
          taskId: linked.id,
          title: linked.title,
        });
        continue;
      }

      const created = createTask({
        projectId,
        title: taskSpec.title,
        description: taskSpec.description,
        priority: taskSpec.priority,
        assignedTo: desiredAssignedTo,
        createdBy: options.actor,
        department: taskSpec.department ?? item.department,
        team: taskSpec.team ?? item.team,
        entityId: entity.id,
        entityType: manifest.kind,
        tags: taskSpec.tags,
        metadata: taskSpec.metadata,
      }, options.dbOverride);
      allTasks.push(created);
      syncReport.push({
        action: "created_task",
        key,
        entityId: entity.id,
        taskId: created.id,
        title: created.title,
      });
    }
  }

  return {
    manifest,
    rows: collectEntityManifestStatus(projectId, manifest, options.dbOverride),
    syncReport,
  };
}
