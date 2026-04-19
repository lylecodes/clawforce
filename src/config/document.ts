import path from "node:path";
import type { ConfigPatch, ConfigPatchPreview } from "./patch.js";
import {
  createArrayAppendPatch,
  createArrayRemoveValuePatch,
  createDiffConfigPatch,
  createMergeConfigPatch,
  createPathMergePatch,
  previewDomainConfigPatch as previewDomainObjectPatch,
  previewGlobalConfigPatch as previewGlobalObjectPatch,
} from "./patch.js";
import {
  applyDomainConfigPatch,
  applyGlobalConfigPatch,
  readDomainConfig as readDomainConfigFile,
  readGlobalConfig as readGlobalConfigFile,
  type WriteResult,
} from "./writer.js";

export type ConfigDocumentScope = "global" | "domain";

export type ConfigDocument = {
  scope: ConfigDocumentScope;
  baseDir: string;
  path: string;
  current: Record<string, unknown>;
  domainId?: string;
};

export type PlannedConfigChange = {
  document: ConfigDocument;
  patch: ConfigPatch;
  preview: ConfigPatchPreview;
  changedPaths: string[];
};

export type ConfigPlanningResult =
  | {
      ok: true;
      plan: PlannedConfigChange;
    }
  | {
      ok: false;
      error: string;
    };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function collectChangedPaths(
  before: unknown,
  after: unknown,
  prefix: string[],
  changedPaths: Set<string>,
): void {
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) {
    return;
  }

  const beforeIsObject = isObjectRecord(before);
  const afterIsObject = isObjectRecord(after);
  if (!beforeIsObject || !afterIsObject) {
    if (Array.isArray(before) && Array.isArray(after)) {
      const sharedLength = Math.max(before.length, after.length);
      if (sharedLength === 0) {
        changedPaths.add(prefix.join(".") || "(root)");
        return;
      }
      for (let index = 0; index < sharedLength; index++) {
        collectChangedPaths(before[index], after[index], [...prefix, String(index)], changedPaths);
      }
      return;
    }
    changedPaths.add(prefix.join(".") || "(root)");
    return;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  if (keys.size === 0) {
    changedPaths.add(prefix.join(".") || "(root)");
    return;
  }

  for (const key of keys) {
    collectChangedPaths(before[key], after[key], [...prefix, key], changedPaths);
  }
}

export function summarizeTopLevelChangedKeys(changedPaths: string[]): string[] {
  const topLevel = new Set<string>();
  for (const changedPath of changedPaths) {
    if (changedPath === "(root)") {
      topLevel.add(changedPath);
      continue;
    }
    topLevel.add(changedPath.split(".")[0]!);
  }
  return [...topLevel];
}

export function loadGlobalConfigDocument(baseDir: string): ConfigDocument {
  return {
    scope: "global",
    baseDir,
    path: path.join(baseDir, "config.yaml"),
    current: cloneRecord(readGlobalConfigFile(baseDir)),
  };
}

export function loadDomainConfigDocument(baseDir: string, domainId: string): ConfigDocument | null {
  const current = readDomainConfigFile(baseDir, domainId);
  if (!current) {
    return null;
  }

  return {
    scope: "domain",
    baseDir,
    path: path.join(baseDir, "domains", `${domainId}.yaml`),
    domainId,
    current: cloneRecord(current),
  };
}

export function planConfigDocumentPatch(
  document: ConfigDocument,
  patch: ConfigPatch,
): PlannedConfigChange {
  const preview = document.scope === "global"
    ? previewGlobalObjectPatch(document.current, patch)
    : previewDomainObjectPatch(document.current, document.domainId!, patch);

  const changedPaths = new Set<string>();
  collectChangedPaths(preview.before, preview.after, [], changedPaths);

  return {
    document,
    patch,
    preview,
    changedPaths: [...changedPaths],
  };
}

export function planGlobalConfigPatch(baseDir: string, patch: ConfigPatch): PlannedConfigChange {
  return planConfigDocumentPatch(loadGlobalConfigDocument(baseDir), patch);
}

export function planDomainConfigPatch(
  baseDir: string,
  domainId: string,
  patch: ConfigPatch,
): ConfigPlanningResult {
  const document = loadDomainConfigDocument(baseDir, domainId);
  if (!document) {
    return { ok: false, error: `Domain "${domainId}" does not exist` };
  }

  return {
    ok: true,
    plan: planConfigDocumentPatch(document, patch),
  };
}

export function planGlobalConfigMerge(
  baseDir: string,
  updates: Record<string, unknown>,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): PlannedConfigChange {
  return planGlobalConfigPatch(baseDir, createMergeConfigPatch(updates, meta));
}

export function planDomainConfigMerge(
  baseDir: string,
  domainId: string,
  updates: Record<string, unknown>,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPlanningResult {
  return planDomainConfigPatch(baseDir, domainId, createMergeConfigPatch(updates, meta));
}

export function planGlobalConfigSectionReplace(
  baseDir: string,
  section: string,
  value: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): PlannedConfigChange {
  const document = loadGlobalConfigDocument(baseDir);
  return planConfigDocumentPatch(
    document,
    createDiffConfigPatch(document.current[section], value, {
      section: meta.section ?? section,
      action: meta.action,
    }, [section]),
  );
}

export function planGlobalConfigPathMerge(
  baseDir: string,
  patchPath: string[],
  value: Record<string, unknown>,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): PlannedConfigChange {
  return planGlobalConfigPatch(baseDir, createPathMergePatch(patchPath, value, meta));
}

export function planDomainConfigPathMerge(
  baseDir: string,
  domainId: string,
  patchPath: string[],
  value: Record<string, unknown>,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPlanningResult {
  return planDomainConfigPatch(baseDir, domainId, createPathMergePatch(patchPath, value, meta));
}

export function planGlobalConfigArrayAppend(
  baseDir: string,
  patchPath: string[],
  value: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): PlannedConfigChange {
  return planGlobalConfigPatch(baseDir, createArrayAppendPatch(patchPath, value, meta));
}

export function planDomainConfigArrayAppend(
  baseDir: string,
  domainId: string,
  patchPath: string[],
  value: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPlanningResult {
  return planDomainConfigPatch(baseDir, domainId, createArrayAppendPatch(patchPath, value, meta));
}

export function planGlobalConfigArrayRemoveValue(
  baseDir: string,
  patchPath: string[],
  value: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): PlannedConfigChange {
  return planGlobalConfigPatch(baseDir, createArrayRemoveValuePatch(patchPath, value, meta));
}

export function planDomainConfigArrayRemoveValue(
  baseDir: string,
  domainId: string,
  patchPath: string[],
  value: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPlanningResult {
  return planDomainConfigPatch(baseDir, domainId, createArrayRemoveValuePatch(patchPath, value, meta));
}

export function planDomainConfigSectionReplace(
  baseDir: string,
  domainId: string,
  section: string,
  value: unknown,
  meta: Pick<ConfigPatch, "section" | "action"> = {},
): ConfigPlanningResult {
  const document = loadDomainConfigDocument(baseDir, domainId);
  if (!document) {
    return { ok: false, error: `Domain "${domainId}" does not exist` };
  }

  return {
    ok: true,
    plan: planConfigDocumentPatch(
      document,
      createDiffConfigPatch(document.current[section], value, {
        section: meta.section ?? section,
        action: meta.action,
      }, [section]),
    ),
  };
}

export function applyPlannedConfigChange(
  plan: PlannedConfigChange,
  actor: string,
): WriteResult {
  return plan.document.scope === "global"
    ? applyGlobalConfigPatch(plan.document.baseDir, plan.patch, actor)
    : applyDomainConfigPatch(plan.document.baseDir, plan.document.domainId!, plan.patch, actor);
}
