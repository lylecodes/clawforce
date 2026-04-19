import type { DomainConfig, GlobalConfig } from "./schema.js";
import { validateDomainConfig, validateGlobalConfig } from "./schema.js";

export type ConfigPatchPath = string[];

export type ConfigPatchOperation =
  | {
      op: "merge";
      value: Record<string, unknown>;
      path?: ConfigPatchPath;
    }
  | {
      op: "replace";
      path: ConfigPatchPath;
      value: unknown;
    }
  | {
      op: "remove";
      path: ConfigPatchPath;
    }
  | {
      op: "append";
      path: ConfigPatchPath;
      value: unknown;
    }
  | {
      op: "remove_value";
      path: ConfigPatchPath;
      value: unknown;
    };

export type ConfigPatch = {
  ops: ConfigPatchOperation[];
  section?: string;
  action?: string;
};

export type ConfigPatchPreview = {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  valid: boolean;
  errors?: string[];
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrayIndexSegment(segment: string): boolean {
  return /^\d+$/.test(segment);
}

function toArrayIndex(segment: string): number {
  return Number(segment);
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (value === null) {
      delete result[key];
      continue;
    }
    if (isObjectRecord(value) && isObjectRecord(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value);
      continue;
    }
    result[key] = cloneValue(value);
  }
  return result;
}

function getValueAtPath(target: Record<string, unknown>, path: ConfigPatchPath): unknown {
  let current: unknown = target;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!isArrayIndexSegment(segment)) {
        return undefined;
      }
      current = current[toArrayIndex(segment)];
      continue;
    }
    if (!isObjectRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setValueAtPath(target: Record<string, unknown>, path: ConfigPatchPath, value: unknown): void {
  let current: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;

    if (Array.isArray(current)) {
      if (!isArrayIndexSegment(segment)) {
        return;
      }
      const arrayIndex = toArrayIndex(segment);
      const next = current[arrayIndex];
      if (!isObjectRecord(next) && !Array.isArray(next)) {
        current[arrayIndex] = isArrayIndexSegment(nextSegment) ? [] : {};
      }
      current = current[arrayIndex] as Record<string, unknown> | unknown[];
      continue;
    }

    const next = current[segment];
    if (!isObjectRecord(next) && !Array.isArray(next)) {
      current[segment] = isArrayIndexSegment(nextSegment) ? [] : {};
    }
    current = current[segment] as Record<string, unknown> | unknown[];
  }

  if (path.length === 0) {
    const nextRoot = cloneValue(value);
    if (isObjectRecord(nextRoot)) {
      for (const key of Object.keys(target)) {
        delete target[key];
      }
      Object.assign(target, nextRoot);
    }
    return;
  }

  const leaf = path[path.length - 1]!;
  if (Array.isArray(current)) {
    if (!isArrayIndexSegment(leaf)) {
      return;
    }
    current[toArrayIndex(leaf)] = cloneValue(value);
    return;
  }

  current[leaf] = cloneValue(value);
}

function removeValueAtPath(target: Record<string, unknown>, path: ConfigPatchPath): void {
  if (path.length === 0) {
    return;
  }

  let current: Record<string, unknown> | unknown[] | undefined = target;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index]!;

    if (Array.isArray(current)) {
      if (!isArrayIndexSegment(segment)) {
        return;
      }
      const next = current[toArrayIndex(segment)];
      if (!isObjectRecord(next) && !Array.isArray(next)) {
        return;
      }
      current = next as Record<string, unknown> | unknown[];
      continue;
    }

    const next: unknown = current?.[segment];
    if (!isObjectRecord(next) && !Array.isArray(next)) {
      return;
    }
    current = next as Record<string, unknown> | unknown[];
  }

  if (current) {
    const leaf = path[path.length - 1]!;
    if (Array.isArray(current)) {
      if (!isArrayIndexSegment(leaf)) {
        return;
      }
      current.splice(toArrayIndex(leaf), 1);
      return;
    }
    delete current[leaf];
  }
}

function collectDiffOps(
  before: unknown,
  after: unknown,
  path: ConfigPatchPath,
  ops: ConfigPatchOperation[],
): void {
  if (valuesEqual(before, after)) {
    return;
  }

  if (isObjectRecord(before) && isObjectRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (!(key in after)) {
        ops.push({ op: "remove", path: [...path, key] });
        continue;
      }
      if (!(key in before)) {
        ops.push({ op: "replace", path: [...path, key], value: after[key] });
        continue;
      }
      collectDiffOps(before[key], after[key], [...path, key], ops);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const sharedLength = Math.min(before.length, after.length);
    for (let index = 0; index < sharedLength; index++) {
      collectDiffOps(before[index], after[index], [...path, String(index)], ops);
    }
    for (let index = before.length - 1; index >= after.length; index--) {
      ops.push({ op: "remove", path: [...path, String(index)] });
    }
    for (let index = sharedLength; index < after.length; index++) {
      ops.push({ op: "append", path, value: after[index] });
    }
    return;
  }

  ops.push({ op: "replace", path, value: after });
}

export function applyConfigPatch(before: Record<string, unknown>, patch: ConfigPatch): Record<string, unknown> {
  let after = cloneValue(before);

  for (const operation of patch.ops) {
    switch (operation.op) {
      case "merge": {
        if (!operation.path || operation.path.length === 0) {
          after = deepMerge(after, operation.value);
          continue;
        }

        const current = getValueAtPath(after, operation.path);
        const merged = deepMerge(isObjectRecord(current) ? current : {}, operation.value);
        setValueAtPath(after, operation.path, merged);
        continue;
      }

      case "replace":
        setValueAtPath(after, operation.path, operation.value);
        continue;

      case "remove":
        removeValueAtPath(after, operation.path);
        continue;

      case "append": {
        const current = getValueAtPath(after, operation.path);
        const next = Array.isArray(current) ? [...current, cloneValue(operation.value)] : [cloneValue(operation.value)];
        setValueAtPath(after, operation.path, next);
        continue;
      }

      case "remove_value": {
        const current = getValueAtPath(after, operation.path);
        if (!Array.isArray(current)) {
          continue;
        }
        const next = current.filter((entry) => !valuesEqual(entry, operation.value));
        setValueAtPath(after, operation.path, next);
        continue;
      }
    }
  }

  return after;
}

export function createMergeConfigPatch(
  updates: Record<string, unknown>,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPatch {
  return {
    ops: [{ op: "merge", value: cloneValue(updates) }],
    ...meta,
  };
}

export function createSectionReplacePatch(
  section: string,
  value: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPatch {
  return {
    ops: [{ op: "replace", path: [section], value: cloneValue(value) }],
    section: meta.section ?? section,
    action: meta.action,
  };
}

export function createPathMergePatch(
  path: ConfigPatchPath,
  value: Record<string, unknown>,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPatch {
  return {
    ops: [{ op: "merge", path, value: cloneValue(value) }],
    ...meta,
  };
}

export function createArrayAppendPatch(
  path: ConfigPatchPath,
  value: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPatch {
  return {
    ops: [{ op: "append", path, value: cloneValue(value) }],
    ...meta,
  };
}

export function createArrayRemoveValuePatch(
  path: ConfigPatchPath,
  value: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPatch {
  return {
    ops: [{ op: "remove_value", path, value: cloneValue(value) }],
    ...meta,
  };
}

export function createDiffConfigPatch(
  before: unknown,
  after: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
  path: ConfigPatchPath = [],
): ConfigPatch {
  const ops: ConfigPatchOperation[] = [];
  collectDiffOps(before, after, path, ops);
  return {
    ops,
    ...meta,
  };
}

export function previewGlobalConfigPatch(
  before: Record<string, unknown>,
  patch: ConfigPatch,
): ConfigPatchPreview {
  const after = applyConfigPatch(before, patch) as GlobalConfig as unknown as Record<string, unknown>;
  const validation = validateGlobalConfig(after as unknown as GlobalConfig);
  return {
    before: cloneValue(before),
    after,
    valid: validation.valid,
    errors: validation.valid ? undefined : validation.errors.map((error) => `${error.field}: ${error.message}`),
  };
}

export function previewDomainConfigPatch(
  before: Record<string, unknown>,
  domainName: string,
  patch: ConfigPatch,
): ConfigPatchPreview {
  const after = applyConfigPatch(before, patch) as DomainConfig as unknown as Record<string, unknown>;
  after.domain = domainName;
  const validation = validateDomainConfig(after as unknown as DomainConfig);
  return {
    before: cloneValue(before),
    after,
    valid: validation.valid,
    errors: validation.valid ? undefined : validation.errors.map((error) => `${error.field}: ${error.message}`),
  };
}
