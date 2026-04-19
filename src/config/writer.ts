/**
 * Clawforce — Config Writer
 *
 * The missing counterpart to loader.ts. Handles field-level YAML
 * read-modify-write for global config and domain config files.
 * Rewrites YAML through the `yaml` package. New files are normalized on write;
 * patch-based edits preserve unrelated comments and ordering when possible.
 *
 * Every write: validate → write YAML → emit event → return diff.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { GlobalConfig, DomainConfig, GlobalAgentDef } from "./schema.js";
import { validateGlobalConfig, validateDomainConfig } from "./schema.js";
import {
  createArrayAppendPatch,
  createArrayRemoveValuePatch,
  createDiffConfigPatch,
  createMergeConfigPatch,
  createPathMergePatch,
  previewDomainConfigPatch as previewDomainConfigObjectPatch,
  previewGlobalConfigPatch as previewGlobalConfigObjectPatch,
  deepMerge,
  type ConfigPatch,
} from "./patch.js";
import { loadGlobalConfig, loadAllDomains } from "./loader.js";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";

// --- Types ---

export type WriteResult = {
  ok: boolean;
  path: string;
  diff?: { before: Record<string, unknown>; after: Record<string, unknown> };
  error?: string;
};

export type ConfigEvent = {
  type: "config_updated";
  actor: string;
  section: string;
  action: string;
  domain?: string;
  diff: { before: Record<string, unknown>; after: Record<string, unknown> };
  timestamp: number;
};

// --- Internal Helpers ---

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function emitConfigEvent(event: ConfigEvent): void {
  try {
    emitDiagnosticEvent({
      type: event.type,
      actor: event.actor,
      section: event.section,
      action: event.action,
      domain: event.domain,
      diff: event.diff,
      timestamp: event.timestamp,
    });
  } catch (err) {
    safeLog("config.writer.emit", err);
  }
}

// --- File I/O ---

function readYaml(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Record<string, unknown>;
}

function writeYaml(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, YAML.stringify(data, { lineWidth: 120 }), "utf-8");
}

function readYamlDocument(filePath: string): YAML.Document | null {
  if (!fs.existsSync(filePath)) return null;
  return YAML.parseDocument(fs.readFileSync(filePath, "utf-8"));
}

function setDocumentValue(doc: YAML.Document, patchPath: string[], value: unknown): void {
  if (patchPath.length === 0) {
    doc.contents = doc.createNode(deepClone(value));
    return;
  }
  doc.setIn(patchPath, deepClone(value));
}

function deleteDocumentValue(doc: YAML.Document, patchPath: string[]): void {
  if (patchPath.length === 0) {
    doc.contents = doc.createNode({});
    return;
  }
  doc.deleteIn(patchPath);
}

function getDocumentNode(doc: YAML.Document, patchPath: string[]): unknown {
  if (patchPath.length === 0) {
    return doc.contents;
  }
  return doc.getIn(patchPath, true);
}

function documentNodeToValue(node: unknown): unknown {
  if (YAML.isScalar(node)) {
    return node.value;
  }
  if (node && typeof node === "object" && "toJSON" in node) {
    const candidate = node as { toJSON?: () => unknown };
    if (typeof candidate.toJSON === "function") {
      return candidate.toJSON();
    }
  }
  return node;
}

function mergeObjectIntoDocument(
  doc: YAML.Document,
  patchPath: string[],
  value: Record<string, unknown>,
): void {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const nextPath = [...patchPath, key];
    if (entry === null) {
      deleteDocumentValue(doc, nextPath);
      continue;
    }

    const existingNode = getDocumentNode(doc, nextPath);
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      if (!YAML.isMap(existingNode)) {
        setDocumentValue(doc, nextPath, {});
      }
      mergeObjectIntoDocument(doc, nextPath, entry as Record<string, unknown>);
      continue;
    }

    if (JSON.stringify(documentNodeToValue(existingNode) ?? null) === JSON.stringify(entry ?? null)) {
      continue;
    }
    setDocumentValue(doc, nextPath, entry);
  }
}

function applyPatchToYamlDocument(doc: YAML.Document, patch: ConfigPatch): void {
  for (const operation of patch.ops) {
    switch (operation.op) {
      case "merge":
        mergeObjectIntoDocument(doc, operation.path ?? [], operation.value);
        break;
      case "replace":
        setDocumentValue(doc, operation.path, operation.value);
        break;
      case "remove":
        deleteDocumentValue(doc, operation.path);
        break;
      case "append": {
        const node = getDocumentNode(doc, operation.path);
        if (YAML.isSeq(node)) {
          node.add(deepClone(operation.value));
          break;
        }
        setDocumentValue(doc, operation.path, [operation.value]);
        break;
      }
      case "remove_value": {
        const node = getDocumentNode(doc, operation.path);
        if (!YAML.isSeq(node)) {
          break;
        }
        for (let index = node.items.length - 1; index >= 0; index--) {
          const entry = node.get(index, true);
          if (JSON.stringify(documentNodeToValue(entry) ?? null) === JSON.stringify(operation.value ?? null)) {
            node.delete(index);
          }
        }
        break;
      }
    }
  }
}

function writePatchedYaml(
  filePath: string,
  patch: ConfigPatch,
  fallbackData: Record<string, unknown>,
  finalize?: (doc: YAML.Document) => void,
): void {
  const doc = readYamlDocument(filePath);
  if (!doc || doc.errors.length > 0) {
    writeYaml(filePath, fallbackData);
    return;
  }

  try {
    applyPatchToYamlDocument(doc, patch);
    finalize?.(doc);
    fs.writeFileSync(filePath, doc.toString({ lineWidth: 120 }), "utf-8");
  } catch {
    writeYaml(filePath, fallbackData);
  }
}

function writeValidatedGlobalPatch(
  baseDir: string,
  patch: ConfigPatch,
  actor: string,
  eventOverride?: {
    section?: string;
    action?: string;
    diff?: { before: Record<string, unknown>; after: Record<string, unknown> };
  },
): WriteResult {
  const configPath = path.join(baseDir, "config.yaml");
  const before = deepClone(readYaml(configPath));
  const preview = previewGlobalConfigObjectPatch(before, patch);

  if (!preview.valid) {
    return {
      ok: false,
      path: configPath,
      error: `Validation failed: ${(preview.errors ?? []).join("; ")}`,
    };
  }

  writePatchedYaml(configPath, patch, preview.after);

  const diff = eventOverride?.diff ?? { before: preview.before, after: preview.after };
  emitConfigEvent({
    type: "config_updated",
    actor,
    section: eventOverride?.section ?? patch.section ?? "global",
    action: eventOverride?.action ?? patch.action ?? "update",
    diff,
    timestamp: Date.now(),
  });

  return { ok: true, path: configPath, diff };
}

function writeValidatedDomainPatch(
  baseDir: string,
  domainName: string,
  patch: ConfigPatch,
  actor: string,
  eventOverride?: {
    section?: string;
    action?: string;
    diff?: { before: Record<string, unknown>; after: Record<string, unknown> };
  },
): WriteResult {
  const filePath = domainFilePath(baseDir, domainName);
  if (!fs.existsSync(filePath)) {
    return { ok: false, path: filePath, error: `Domain "${domainName}" does not exist` };
  }

  const before = deepClone(readYaml(filePath));
  const preview = previewDomainConfigObjectPatch(before, domainName, patch);

  if (!preview.valid) {
    return {
      ok: false,
      path: filePath,
      error: `Validation failed: ${(preview.errors ?? []).join("; ")}`,
    };
  }

  writePatchedYaml(filePath, patch, preview.after, (doc) => {
    doc.setIn(["domain"], domainName);
  });

  const diff = eventOverride?.diff ?? { before: preview.before, after: preview.after };
  emitConfigEvent({
    type: "config_updated",
    actor,
    section: eventOverride?.section ?? patch.section ?? "domain",
    action: eventOverride?.action ?? patch.action ?? "update",
    domain: domainName,
    diff,
    timestamp: Date.now(),
  });

  return { ok: true, path: filePath, diff };
}

// --- Global Config Writer ---

export function readGlobalConfig(baseDir: string): GlobalConfig {
  return loadGlobalConfig(baseDir);
}

export function writeGlobalConfig(baseDir: string, config: GlobalConfig): WriteResult {
  const configPath = path.join(baseDir, "config.yaml");
  const validation = validateGlobalConfig(config);
  if (!validation.valid) {
    return {
      ok: false,
      path: configPath,
      error: `Validation failed: ${validation.errors.map(e => `${e.field}: ${e.message}`).join("; ")}`,
    };
  }
  if (!fs.existsSync(configPath)) {
    writeYaml(configPath, config as unknown as Record<string, unknown>);
    return { ok: true, path: configPath };
  }

  const before = deepClone(readYaml(configPath));
  writePatchedYaml(
    configPath,
    createDiffConfigPatch(before, config as unknown as Record<string, unknown>, {
      section: "global",
      action: "replace",
    }),
    config as unknown as Record<string, unknown>,
  );
  return { ok: true, path: configPath };
}

export function applyGlobalConfigPatch(
  baseDir: string,
  patch: ConfigPatch,
  actor: string,
): WriteResult {
  return writeValidatedGlobalPatch(baseDir, patch, actor);
}

/**
 * Update specific fields in the global config using deep merge.
 */
export function updateGlobalConfig(
  baseDir: string,
  updates: Record<string, unknown>,
  actor: string,
): WriteResult {
  return applyGlobalConfigPatch(
    baseDir,
    createMergeConfigPatch(updates, { section: "global", action: "update" }),
    actor,
  );
}

// --- Domain Config Writer ---

function domainFilePath(baseDir: string, domainName: string): string {
  return path.join(baseDir, "domains", `${domainName}.yaml`);
}

export function readDomainConfig(baseDir: string, domainName: string): DomainConfig | null {
  const filePath = domainFilePath(baseDir, domainName);
  if (!fs.existsSync(filePath)) return null;
  const raw = readYaml(filePath);
  return raw as unknown as DomainConfig;
}

export function writeDomainConfig(baseDir: string, domainName: string, config: DomainConfig): WriteResult {
  const filePath = domainFilePath(baseDir, domainName);
  const validation = validateDomainConfig(config);
  if (!validation.valid) {
    return {
      ok: false,
      path: filePath,
      error: `Validation failed: ${validation.errors.map(e => `${e.field}: ${e.message}`).join("; ")}`,
    };
  }
  if (!fs.existsSync(filePath)) {
    writeYaml(filePath, config as unknown as Record<string, unknown>);
    return { ok: true, path: filePath };
  }

  const before = deepClone(readYaml(filePath));
  writePatchedYaml(
    filePath,
    createDiffConfigPatch(before, config as unknown as Record<string, unknown>, {
      section: "domain",
      action: "replace",
    }),
    config as unknown as Record<string, unknown>,
    (doc) => {
      doc.setIn(["domain"], domainName);
    },
  );
  return { ok: true, path: filePath };
}

export function applyDomainConfigPatch(
  baseDir: string,
  domainName: string,
  patch: ConfigPatch,
  actor: string,
): WriteResult {
  return writeValidatedDomainPatch(baseDir, domainName, patch, actor);
}

/**
 * Update specific fields in a domain config using deep merge.
 */
export function updateDomainConfig(
  baseDir: string,
  domainName: string,
  updates: Record<string, unknown>,
  actor: string,
): WriteResult {
  return applyDomainConfigPatch(
    baseDir,
    domainName,
    createMergeConfigPatch(updates, { section: "domain", action: "update" }),
    actor,
  );
}

export function deleteDomainConfig(baseDir: string, domainName: string, actor: string): WriteResult {
  const filePath = domainFilePath(baseDir, domainName);
  if (!fs.existsSync(filePath)) {
    return { ok: false, path: filePath, error: `Domain "${domainName}" does not exist` };
  }

  const before = deepClone(readYaml(filePath));
  fs.unlinkSync(filePath);

  emitConfigEvent({
    type: "config_updated",
    actor,
    section: "domain",
    action: "delete",
    domain: domainName,
    diff: { before, after: {} },
    timestamp: Date.now(),
  });

  return { ok: true, path: filePath, diff: { before, after: {} } };
}

// --- Agent operations ---

/**
 * Add or update an agent in the global config.
 */
export function upsertGlobalAgent(
  baseDir: string,
  agentId: string,
  agentDef: GlobalAgentDef,
  actor: string,
): WriteResult {
  const config = readGlobalConfig(baseDir);
  const before = deepClone(config.agents[agentId] ?? {});
  const after = deepClone(agentDef as unknown as Record<string, unknown>);
  return writeValidatedGlobalPatch(
    baseDir,
    createPathMergePatch(["agents", agentId], agentDef as unknown as Record<string, unknown>, {
      section: "agents",
      action: before && Object.keys(before).length > 0 ? "update" : "add",
    }),
    actor,
    {
      section: "agents",
      action: before && Object.keys(before).length > 0 ? "update" : "add",
      diff: { before: before as Record<string, unknown>, after },
    },
  );
}

/**
 * Remove an agent from the global config and optionally all domains.
 */
export function removeGlobalAgent(
  baseDir: string,
  agentId: string,
  removeFromDomains: boolean,
  actor: string,
): WriteResult {
  const config = readGlobalConfig(baseDir);
  const before = deepClone(config.agents[agentId] ?? {}) as Record<string, unknown>;
  if (!config.agents[agentId]) {
    return { ok: false, path: path.join(baseDir, "config.yaml"), error: `Agent "${agentId}" not found in global config` };
  }

  const result = writeValidatedGlobalPatch(
    baseDir,
    {
      ops: [{ op: "remove", path: ["agents", agentId] }],
      section: "agents",
      action: "remove",
    },
    actor,
    {
      section: "agents",
      action: "remove",
      diff: { before, after: {} },
    },
  );
  if (!result.ok) return result;

  // Remove from all domain configs
  if (removeFromDomains) {
      const domains = loadAllDomains(baseDir);
      for (const domain of domains) {
        if (domain.agents.includes(agentId)) {
          removeAgentFromDomain(baseDir, domain.domain, agentId, actor);
        }
      }
  }
  return result;
}

/**
 * Update specific fields on an existing agent (field-level merge).
 */
export function updateGlobalAgent(
  baseDir: string,
  agentId: string,
  updates: Record<string, unknown>,
  actor: string,
): WriteResult {
  const config = readGlobalConfig(baseDir);
  if (!config.agents[agentId]) {
    return { ok: false, path: path.join(baseDir, "config.yaml"), error: `Agent "${agentId}" not found in global config` };
  }

  const before = deepClone(config.agents[agentId]) as Record<string, unknown>;
  const next = deepMerge(
    config.agents[agentId] as unknown as Record<string, unknown>,
    updates,
  ) as unknown as GlobalAgentDef;
  const after = deepClone(next) as unknown as Record<string, unknown>;
  return writeValidatedGlobalPatch(
    baseDir,
    createPathMergePatch(["agents", agentId], updates, {
      section: "agents",
      action: "update",
    }),
    actor,
    {
      section: "agents",
      action: "update",
      diff: { before, after },
    },
  );
}

/**
 * Add an agent to a specific domain's agents list.
 */
export function addAgentToDomain(
  baseDir: string,
  domainName: string,
  agentId: string,
  actor: string,
): WriteResult {
  const domain = readDomainConfig(baseDir, domainName);
  if (!domain) {
    return { ok: false, path: domainFilePath(baseDir, domainName), error: `Domain "${domainName}" does not exist` };
  }
  if (domain.agents.includes(agentId)) {
    return { ok: true, path: domainFilePath(baseDir, domainName) }; // already present, idempotent
  }

  const before = deepClone(domain) as unknown as Record<string, unknown>;
  const nextAgents = [...domain.agents, agentId];
  const after = deepClone({ ...domain, agents: nextAgents }) as unknown as Record<string, unknown>;
  return writeValidatedDomainPatch(
    baseDir,
    domainName,
    createArrayAppendPatch(["agents"], agentId, {
      section: "domain.agents",
      action: "add",
    }),
    actor,
    {
      section: "domain.agents",
      action: "add",
      diff: { before, after },
    },
  );
}

/**
 * Remove an agent from a specific domain's agents list.
 */
export function removeAgentFromDomain(
  baseDir: string,
  domainName: string,
  agentId: string,
  actor: string,
): WriteResult {
  const domain = readDomainConfig(baseDir, domainName);
  if (!domain) {
    return { ok: false, path: domainFilePath(baseDir, domainName), error: `Domain "${domainName}" does not exist` };
  }
  if (!domain.agents.includes(agentId)) {
    return { ok: true, path: domainFilePath(baseDir, domainName) }; // not present, idempotent
  }

  const before = deepClone(domain) as unknown as Record<string, unknown>;
  const nextAgents = domain.agents.filter(a => a !== agentId);
  const manager = domain.manager as Record<string, unknown> | undefined;
  const ops: ConfigPatch["ops"] = [
    ...createArrayRemoveValuePatch(["agents"], agentId).ops,
  ];
  const afterDomain: Record<string, unknown> = {
    ...(domain as unknown as Record<string, unknown>),
    agents: nextAgents,
  };
  if (manager?.agentId === agentId) {
    ops.push({ op: "remove", path: ["manager"] });
    delete afterDomain.manager;
  }
  return writeValidatedDomainPatch(
    baseDir,
    domainName,
    {
      ops,
      section: "domain.agents",
      action: "remove",
    },
    actor,
    {
      section: "domain.agents",
      action: "remove",
      diff: { before, after: afterDomain },
    },
  );
}

// --- Section-level operations ---

/**
 * Set any section on a domain config.
 */
export function setDomainSection(
  baseDir: string,
  domainName: string,
  section: string,
  value: unknown,
  actor: string,
): WriteResult {
  const domain = readDomainConfig(baseDir, domainName);
  if (!domain) {
    return { ok: false, path: domainFilePath(baseDir, domainName), error: `Domain "${domainName}" does not exist` };
  }

  return applyDomainConfigPatch(
    baseDir,
    domainName,
    createDiffConfigPatch((domain as unknown as Record<string, unknown>)[section], value, {
      section: "domain",
      action: "update",
    }, [section]),
    actor,
  );
}

/**
 * Set any section on the global config.
 */
export function setGlobalSection(
  baseDir: string,
  section: string,
  value: unknown,
  actor: string,
): WriteResult {
  return applyGlobalConfigPatch(
    baseDir,
    createDiffConfigPatch(readGlobalConfig(baseDir)[section as keyof GlobalConfig], value, {
      section: "global",
      action: "update",
    }, [section]),
    actor,
  );
}

export function previewGlobalConfigPatch(
  baseDir: string,
  patch: ConfigPatch,
): { before: Record<string, unknown>; after: Record<string, unknown>; valid: boolean; errors?: string[] } {
  const configPath = path.join(baseDir, "config.yaml");
  return previewGlobalConfigObjectPatch(readYaml(configPath), patch);
}

export function previewDomainConfigPatch(
  baseDir: string,
  domainName: string,
  patch: ConfigPatch,
): { before: Record<string, unknown>; after: Record<string, unknown>; valid: boolean; errors?: string[] } {
  const filePath = domainFilePath(baseDir, domainName);
  return previewDomainConfigObjectPatch(readYaml(filePath), domainName, patch);
}

// --- Preview (diff without writing) ---

/**
 * Preview what a change to global config would look like without writing.
 */
export function previewGlobalChange(
  baseDir: string,
  updates: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown>; valid: boolean; errors?: string[] } {
  return previewGlobalConfigPatch(baseDir, createMergeConfigPatch(updates));
}

/**
 * Preview what a change to a domain config would look like without writing.
 */
export function previewDomainChange(
  baseDir: string,
  domainName: string,
  updates: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown>; valid: boolean; errors?: string[] } {
  return previewDomainConfigPatch(baseDir, domainName, createMergeConfigPatch(updates));
}

// Re-export deepMerge for testing
export { deepMerge };
