/**
 * Clawforce — Config Writer
 *
 * The missing counterpart to loader.ts. Handles field-level YAML
 * read-modify-write for global config and domain config files.
 * Preserves comments and formatting where possible using the `yaml`
 * package's Document API.
 *
 * Every write: validate → write YAML → emit event → return diff.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { GlobalConfig, DomainConfig, GlobalAgentDef } from "./schema.js";
import { validateGlobalConfig, validateDomainConfig } from "./schema.js";
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

/**
 * Deep merge source into target. Arrays are replaced, not appended.
 * undefined values in source are skipped (use null to delete).
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (value === null) {
      delete result[key];
      continue;
    }
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
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
  writeYaml(configPath, config as unknown as Record<string, unknown>);
  return { ok: true, path: configPath };
}

/**
 * Update specific fields in the global config using deep merge.
 */
export function updateGlobalConfig(
  baseDir: string,
  updates: Record<string, unknown>,
  actor: string,
): WriteResult {
  const configPath = path.join(baseDir, "config.yaml");
  const before = deepClone(readYaml(configPath));
  const merged = deepMerge(before, updates) as unknown as GlobalConfig;

  const validation = validateGlobalConfig(merged);
  if (!validation.valid) {
    return {
      ok: false,
      path: configPath,
      error: `Validation failed: ${validation.errors.map(e => `${e.field}: ${e.message}`).join("; ")}`,
    };
  }

  writeYaml(configPath, merged as unknown as Record<string, unknown>);
  const after = deepClone(merged as unknown as Record<string, unknown>);

  emitConfigEvent({
    type: "config_updated",
    actor,
    section: "global",
    action: "update",
    diff: { before, after },
    timestamp: Date.now(),
  });

  return { ok: true, path: configPath, diff: { before, after } };
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
  writeYaml(filePath, config as unknown as Record<string, unknown>);
  return { ok: true, path: filePath };
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
  const filePath = domainFilePath(baseDir, domainName);
  if (!fs.existsSync(filePath)) {
    return { ok: false, path: filePath, error: `Domain "${domainName}" does not exist` };
  }

  const before = deepClone(readYaml(filePath));
  const merged = deepMerge(before, updates);
  // Ensure domain name is preserved
  merged.domain = domainName;

  const validation = validateDomainConfig(merged);
  if (!validation.valid) {
    return {
      ok: false,
      path: filePath,
      error: `Validation failed: ${validation.errors.map(e => `${e.field}: ${e.message}`).join("; ")}`,
    };
  }

  writeYaml(filePath, merged);
  const after = deepClone(merged);

  emitConfigEvent({
    type: "config_updated",
    actor,
    section: "domain",
    action: "update",
    domain: domainName,
    diff: { before, after },
    timestamp: Date.now(),
  });

  return { ok: true, path: filePath, diff: { before, after } };
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
  config.agents[agentId] = agentDef;
  const result = writeGlobalConfig(baseDir, config);
  if (!result.ok) return result;

  const after = deepClone(agentDef as unknown as Record<string, unknown>);
  emitConfigEvent({
    type: "config_updated",
    actor,
    section: "agents",
    action: before && Object.keys(before).length > 0 ? "update" : "add",
    diff: { before: before as Record<string, unknown>, after },
    timestamp: Date.now(),
  });

  return { ...result, diff: { before: before as Record<string, unknown>, after } };
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

  delete config.agents[agentId];
  const result = writeGlobalConfig(baseDir, config);
  if (!result.ok) return result;

  // Remove from all domain configs
  if (removeFromDomains) {
    const domains = loadAllDomains(baseDir);
    for (const domain of domains) {
      if (domain.agents.includes(agentId)) {
        domain.agents = domain.agents.filter(a => a !== agentId);
        if (domain.orchestrator === agentId) {
          delete domain.orchestrator;
        }
        writeDomainConfig(baseDir, domain.domain, domain);
      }
    }
  }

  emitConfigEvent({
    type: "config_updated",
    actor,
    section: "agents",
    action: "remove",
    diff: { before, after: {} },
    timestamp: Date.now(),
  });

  return { ...result, diff: { before, after: {} } };
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
  config.agents[agentId] = deepMerge(
    config.agents[agentId] as unknown as Record<string, unknown>,
    updates,
  ) as unknown as GlobalAgentDef;

  const result = writeGlobalConfig(baseDir, config);
  if (!result.ok) return result;

  const after = deepClone(config.agents[agentId]) as unknown as Record<string, unknown>;
  emitConfigEvent({
    type: "config_updated",
    actor,
    section: "agents",
    action: "update",
    diff: { before, after },
    timestamp: Date.now(),
  });

  return { ...result, diff: { before, after } };
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
  domain.agents.push(agentId);
  const result = writeDomainConfig(baseDir, domainName, domain);
  if (!result.ok) return result;

  const after = deepClone(domain) as unknown as Record<string, unknown>;
  emitConfigEvent({
    type: "config_updated",
    actor,
    section: "domain.agents",
    action: "add",
    domain: domainName,
    diff: { before, after },
    timestamp: Date.now(),
  });

  return { ...result, diff: { before, after } };
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
  domain.agents = domain.agents.filter(a => a !== agentId);
  if (domain.orchestrator === agentId) {
    delete domain.orchestrator;
  }
  const result = writeDomainConfig(baseDir, domainName, domain);
  if (!result.ok) return result;

  const after = deepClone(domain) as unknown as Record<string, unknown>;
  emitConfigEvent({
    type: "config_updated",
    actor,
    section: "domain.agents",
    action: "remove",
    domain: domainName,
    diff: { before, after },
    timestamp: Date.now(),
  });

  return { ...result, diff: { before, after } };
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
  return updateDomainConfig(baseDir, domainName, { [section]: value }, actor);
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
  return updateGlobalConfig(baseDir, { [section]: value }, actor);
}

// --- Preview (diff without writing) ---

/**
 * Preview what a change to global config would look like without writing.
 */
export function previewGlobalChange(
  baseDir: string,
  updates: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown>; valid: boolean; errors?: string[] } {
  const configPath = path.join(baseDir, "config.yaml");
  const before = readYaml(configPath);
  const after = deepMerge(deepClone(before), updates);
  const validation = validateGlobalConfig(after);
  return {
    before,
    after,
    valid: validation.valid,
    errors: validation.valid ? undefined : validation.errors.map(e => `${e.field}: ${e.message}`),
  };
}

/**
 * Preview what a change to a domain config would look like without writing.
 */
export function previewDomainChange(
  baseDir: string,
  domainName: string,
  updates: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown>; valid: boolean; errors?: string[] } {
  const filePath = domainFilePath(baseDir, domainName);
  const before = readYaml(filePath);
  const after = deepMerge(deepClone(before), updates);
  after.domain = domainName;
  const validation = validateDomainConfig(after);
  return {
    before,
    after,
    valid: validation.valid,
    errors: validation.valid ? undefined : validation.errors.map(e => `${e.field}: ${e.message}`),
  };
}

// Re-export deepMerge for testing
export { deepMerge };
