/**
 * Clawforce -- Config API Service
 *
 * Encapsulates all config read/write operations behind a clean service layer.
 * The dashboard and other API consumers call these functions instead of doing
 * raw file I/O. This module owns all knowledge of ~/.clawforce paths.
 *
 * Delegates to config/writer.ts and config/loader.ts for actual YAML I/O.
 */

import path from "node:path";
import fs from "node:fs";
import type { DomainConfig, GlobalConfig, GlobalAgentDef } from "./schema.js";
import { validateDomainConfig } from "./schema.js";
import {
  deleteDomainConfig as deleteDomainConfigFile,
  readDomainConfig as readDomainConfigFile,
  writeDomainConfig as writeDomainConfigFile,
  readGlobalConfig as readGlobalConfigFile,
} from "./writer.js";
import {
  applyPlannedConfigChange,
  planDomainConfigPatch,
  planDomainConfigArrayAppend,
  planGlobalConfigPatch,
  planGlobalConfigPathMerge,
  planDomainConfigMerge,
  planDomainConfigSectionReplace,
  planGlobalConfigMerge,
  planGlobalConfigSectionReplace,
  summarizeTopLevelChangedKeys,
} from "./document.js";
import { createArrayRemoveValuePatch } from "./patch.js";
import { loadAllDomains, loadGlobalConfig } from "./loader.js";
import { scaffoldConfigDir } from "./wizard.js";
import { initializeAllDomains, reloadDomain, reloadDomains } from "./init.js";
import { safeLog } from "../diagnostics.js";
import { getClawforceHome } from "../paths.js";

export type ConfigServiceOptions = {
  baseDir?: string;
};

export type ConfigReloadResult = {
  domains: string[];
  errors: string[];
  warnings?: string[];
};

export type SaveDomainConfigSectionOptions = {
  reload?: "domain" | "none";
};

export type SaveDomainConfigChangesOptions = SaveDomainConfigSectionOptions;

export type ConfigPreviewResult = {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  valid: boolean;
  errors?: string[];
  changedPaths: string[];
  changedKeys: string[];
};

type ConfigWriteResult = {
  ok: boolean;
  error?: string;
  warnings?: string[];
  reloadErrors?: string[];
};

type ConfigDeleteResult = ConfigWriteResult & {
  removed?: boolean;
};

type GlobalAgentUpsertResult = {
  ok: boolean;
  created?: boolean;
  error?: string;
};

type GlobalAgentRemovalResult = ConfigWriteResult & {
  removed?: boolean;
  impactedDomains?: string[];
};

type PlannedConfigChange = Parameters<typeof applyPlannedConfigChange>[0];

function resolveBaseDir(baseDir?: string): string {
  return baseDir ?? getClawforceHome();
}

function toPreviewResult(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  valid: boolean,
  errors: string[] | undefined,
  changedPaths: string[],
): ConfigPreviewResult {
  return {
    before,
    after,
    valid,
    ...(errors && errors.length > 0 ? { errors } : {}),
    changedPaths,
    changedKeys: summarizeTopLevelChangedKeys(changedPaths),
  };
}

function persistPlannedChange(plan: PlannedConfigChange, actor: string): ConfigWriteResult {
  if (!plan.preview.valid) {
    return {
      ok: false,
      error: `Validation failed: ${(plan.preview.errors ?? []).join("; ")}`,
    };
  }

  const result = applyPlannedConfigChange(plan, actor);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true };
}

function withDomainReload(
  baseDir: string,
  projectId: string,
  writeResult: ConfigWriteResult,
  options: SaveDomainConfigSectionOptions,
): ConfigWriteResult {
  if (!writeResult.ok || options.reload === "none") {
    return writeResult;
  }

  try {
    const reloadResult = reloadDomain(baseDir, projectId);
    if (reloadResult.errors.length === 0 && reloadResult.warnings.length === 0) {
      return { ok: true };
    }

    return {
      ok: true,
      ...(reloadResult.warnings.length > 0 ? { warnings: reloadResult.warnings } : {}),
      ...(reloadResult.errors.length > 0 ? { reloadErrors: reloadResult.errors } : {}),
    };
  } catch (err) {
    safeLog("config.api-service", `Runtime reload after config update failed: ${err}`);
    return {
      ok: true,
      warnings: [`Runtime reload failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

function readDomainConfigAt(baseDir: string, projectId: string): DomainConfig | null {
  return readDomainConfigFile(baseDir, projectId);
}

function readGlobalConfigAt(baseDir: string): GlobalConfig {
  return loadGlobalConfig(baseDir);
}

function getDomainContextDirAt(baseDir: string, projectId: string): string {
  return path.join(baseDir, "domains", projectId, "context");
}

function saveDomainConfigSectionAt(
  baseDir: string,
  projectId: string,
  section: string,
  data: unknown,
  actor = "dashboard",
  options: SaveDomainConfigSectionOptions = {},
): ConfigWriteResult {
  const planned = planDomainConfigSectionReplace(
    baseDir,
    projectId,
    section,
    data,
    { section: "domain", action: "update" },
  );

  if (!planned.ok) {
    return { ok: false, error: planned.error };
  }

  return withDomainReload(baseDir, projectId, persistPlannedChange(planned.plan, actor), options);
}

function saveDomainConfigChangesAt(
  baseDir: string,
  projectId: string,
  updates: Record<string, unknown>,
  actor = "dashboard",
  options: SaveDomainConfigChangesOptions = {},
): ConfigWriteResult {
  const planned = planDomainConfigMerge(baseDir, projectId, updates, {
    section: "domain",
    action: "update",
  });

  if (!planned.ok) {
    return { ok: false, error: planned.error };
  }

  return withDomainReload(baseDir, projectId, persistPlannedChange(planned.plan, actor), options);
}

function saveGlobalConfigSectionAt(
  baseDir: string,
  section: string,
  data: unknown,
  actor = "dashboard",
): ConfigWriteResult {
  const planned = planGlobalConfigSectionReplace(
    baseDir,
    section,
    data,
    { section: "global", action: "update" },
  );

  return persistPlannedChange(planned, actor);
}

function saveGlobalConfigChangesAt(
  baseDir: string,
  updates: Record<string, unknown>,
  actor = "dashboard",
): ConfigWriteResult {
  const planned = planGlobalConfigMerge(baseDir, updates, {
    section: "global",
    action: "update",
  });

  return persistPlannedChange(planned, actor);
}

function reloadDomainRuntimeAt(baseDir: string, projectId: string): ConfigReloadResult {
  try {
    const result = reloadDomain(baseDir, projectId);
    return {
      domains: result.domains,
      errors: result.errors,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  } catch (err) {
    return { domains: [], errors: [err instanceof Error ? err.message : String(err)] };
  }
}

function reloadDomainRuntimesAt(baseDir: string, projectIds: Iterable<string>): ConfigReloadResult {
  try {
    const result = reloadDomains(baseDir, projectIds);
    return {
      domains: result.domains,
      errors: result.errors,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  } catch (err) {
    return { domains: [], errors: [err instanceof Error ? err.message : String(err)] };
  }
}

function previewDomainConfigChangeAt(
  baseDir: string,
  projectId: string,
  updates: Record<string, unknown>,
): { ok: true; preview: ConfigPreviewResult } | { ok: false; error: string } {
  const planned = planDomainConfigMerge(baseDir, projectId, updates, {
    section: "domain",
    action: "update",
  });

  if (!planned.ok) {
    return { ok: false, error: planned.error };
  }

  return {
    ok: true,
    preview: toPreviewResult(
      planned.plan.preview.before,
      planned.plan.preview.after,
      planned.plan.preview.valid,
      planned.plan.preview.errors,
      planned.plan.changedPaths,
    ),
  };
}

function previewGlobalConfigChangeAt(
  baseDir: string,
  updates: Record<string, unknown>,
): ConfigPreviewResult {
  const planned = planGlobalConfigMerge(baseDir, updates, {
    section: "global",
    action: "update",
  });

  return toPreviewResult(
    planned.preview.before,
    planned.preview.after,
    planned.preview.valid,
    planned.preview.errors,
    planned.changedPaths,
  );
}

function previewDomainConfigSectionChangeAt(
  baseDir: string,
  projectId: string,
  section: string,
  data: unknown,
): { ok: true; preview: ConfigPreviewResult } | { ok: false; error: string } {
  const planned = planDomainConfigSectionReplace(
    baseDir,
    projectId,
    section,
    data,
    { section: "domain", action: "update" },
  );

  if (!planned.ok) {
    return { ok: false, error: planned.error };
  }

  return {
    ok: true,
    preview: toPreviewResult(
      planned.plan.preview.before,
      planned.plan.preview.after,
      planned.plan.preview.valid,
      planned.plan.preview.errors,
      planned.plan.changedPaths,
    ),
  };
}

function previewGlobalConfigSectionChangeAt(
  baseDir: string,
  section: string,
  data: unknown,
): ConfigPreviewResult {
  const planned = planGlobalConfigSectionReplace(
    baseDir,
    section,
    data,
    { section: "global", action: "update" },
  );

  return toPreviewResult(
    planned.preview.before,
    planned.preview.after,
    planned.preview.valid,
    planned.preview.errors,
    planned.changedPaths,
  );
}

function updateGlobalAgentConfigAt(
  baseDir: string,
  agentId: string,
  updates: Record<string, unknown>,
  actor = "dashboard",
): { ok: boolean; error?: string } {
  const globalConfig = readGlobalConfigFile(baseDir);
  if (!globalConfig.agents[agentId]) {
    return { ok: false, error: `Agent "${agentId}" not found in global config` };
  }

  const planned = planGlobalConfigPathMerge(
    baseDir,
    ["agents", agentId],
    updates,
    { section: "agents", action: "update" },
  );
  const result = persistPlannedChange(planned, actor);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

function createDomainAt(
  baseDir: string,
  domainId: string,
  config: Record<string, unknown>,
): { ok: boolean; error?: string } {
  try {
    scaffoldConfigDir(baseDir);
    const domainPath = path.join(baseDir, "domains", `${domainId}.yaml`);
    if (fs.existsSync(domainPath)) {
      return { ok: false, error: `Domain "${domainId}" already exists at ${domainPath}` };
    }

    const domainConfig: Record<string, unknown> = {
      domain: domainId,
      agents: [],
      ...config,
    };
    domainConfig.domain = domainId;

    const validation = validateDomainConfig(domainConfig);
    if (!validation.valid) {
      const details = validation.errors.map(e => `${e.field}: ${e.message}`).join("; ");
      return { ok: false, error: `Validation failed: ${details}` };
    }

    fs.mkdirSync(path.join(baseDir, "domains"), { recursive: true });

    const result = writeDomainConfigFile(baseDir, domainId, domainConfig as DomainConfig);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    try {
      reloadDomain(baseDir, domainId);
    } catch (err) {
      safeLog("config.api-service", `Runtime reload after domain creation failed: ${err}`);
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function upsertGlobalAgentsAt(
  baseDir: string,
  agents: Record<string, GlobalAgentDef>,
  actor = "dashboard",
): { ok: boolean; error?: string } {
  try {
    const patch = {
      ops: Object.entries(agents).map(([agentId, agentDef]) => ({
        op: "merge" as const,
        path: ["agents", agentId],
        value: agentDef as unknown as Record<string, unknown>,
      })),
      section: "agents",
      action: "update",
    };
    const result = persistPlannedChange(planGlobalConfigPatch(baseDir, patch), actor);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function writeDomainConfigAt(
  baseDir: string,
  domainId: string,
  config: DomainConfig,
): { ok: boolean; error?: string } {
  try {
    scaffoldConfigDir(baseDir);
    const result = writeDomainConfigFile(baseDir, domainId, config);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function reloadAllDomainsAt(baseDir: string): { domains: string[]; errors: string[] } {
  try {
    const result = initializeAllDomains(baseDir);
    return { domains: result.domains, errors: result.errors };
  } catch (err) {
    return { domains: [], errors: [err instanceof Error ? err.message : String(err)] };
  }
}

function addGlobalAgentAt(
  baseDir: string,
  agentId: string,
  agentDef: GlobalAgentDef,
  actor = "dashboard",
  force = false,
): GlobalAgentUpsertResult {
  const globalConfig = readGlobalConfigFile(baseDir);
  if (globalConfig.agents[agentId] && !force) {
    return { ok: true, created: false };
  }

  const planned = planGlobalConfigPathMerge(
    baseDir,
    ["agents", agentId],
    agentDef as unknown as Record<string, unknown>,
    { section: "agents", action: globalConfig.agents[agentId] ? "update" : "add" },
  );
  const result = persistPlannedChange(planned, actor);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, created: true };
}

function addAgentToDomainAt(
  baseDir: string,
  projectId: string,
  agentId: string,
  actor = "dashboard",
): ConfigWriteResult {
  const domainConfig = readDomainConfigAt(baseDir, projectId);
  if (!domainConfig) {
    return { ok: false, error: `Domain "${projectId}" does not exist` };
  }
  if (domainConfig.agents.includes(agentId)) {
    return { ok: true };
  }

  const planned = planDomainConfigArrayAppend(
    baseDir,
    projectId,
    ["agents"],
    agentId,
    { section: "domain.agents", action: "add" },
  );
  if (!planned.ok) {
    return { ok: false, error: planned.error };
  }

  return withDomainReload(baseDir, projectId, persistPlannedChange(planned.plan, actor), {
    reload: "domain",
  });
}

function removeGlobalAgentAt(
  baseDir: string,
  agentId: string,
  actor = "dashboard",
  removeFromDomains = false,
): GlobalAgentRemovalResult {
  const globalConfig = readGlobalConfigFile(baseDir);
  if (!globalConfig.agents[agentId]) {
    return { ok: true, removed: false, impactedDomains: [] };
  }

  const impactedDomains = removeFromDomains
    ? loadAllDomains(baseDir)
      .filter((domain) => domain.agents.includes(agentId))
      .map((domain) => domain.domain)
    : [];

  const saveResult = persistPlannedChange(
    planGlobalConfigPatch(
      baseDir,
      {
        ops: [{ op: "remove", path: ["agents", agentId] }],
        section: "agents",
        action: "remove",
      },
    ),
    actor,
  );
  if (!saveResult.ok) {
    return { ok: false, error: saveResult.error };
  }

  if (!removeFromDomains || impactedDomains.length === 0) {
    return { ok: true, removed: true, impactedDomains };
  }

  for (const domainId of impactedDomains) {
    const domainConfig = readDomainConfigAt(baseDir, domainId);
    if (!domainConfig) continue;

    const manager = domainConfig.manager as Record<string, unknown> | undefined;
    const patch = createArrayRemoveValuePatch(["agents"], agentId, {
      section: "domain.agents",
      action: "remove",
    });
    if (manager?.agentId === agentId) {
      patch.ops.push({ op: "remove", path: ["manager"] });
    }
    const domainResultPlan = planDomainConfigPatch(baseDir, domainId, patch);
    if (!domainResultPlan.ok) {
      return {
        ok: false,
        error: domainResultPlan.error,
        impactedDomains,
      };
    }
    const domainResult = withDomainReload(
      baseDir,
      domainId,
      persistPlannedChange(domainResultPlan.plan, actor),
      { reload: "domain" },
    );
    if (!domainResult.ok) {
      return {
        ok: false,
        error: domainResult.error,
        impactedDomains,
      };
    }
  }

  return { ok: true, removed: true, impactedDomains };
}

function deleteDomainAt(
  baseDir: string,
  domainId: string,
  actor = "dashboard",
): ConfigDeleteResult {
  const result = deleteDomainConfigFile(baseDir, domainId, actor);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const reloadResult = reloadDomainRuntimeAt(baseDir, domainId);
  return {
    ok: true,
    removed: true,
    ...(reloadResult.warnings ? { warnings: reloadResult.warnings } : {}),
    ...(reloadResult.errors.length > 0 ? { reloadErrors: reloadResult.errors } : {}),
  };
}

export function createConfigService(options: ConfigServiceOptions = {}) {
  const baseDir = resolveBaseDir(options.baseDir);

  return {
    readDomainConfig(projectId: string): DomainConfig | null {
      return readDomainConfigAt(baseDir, projectId);
    },
    readGlobalConfig(): GlobalConfig {
      return readGlobalConfigAt(baseDir);
    },
    getDomainContextDir(projectId: string): string {
      return getDomainContextDirAt(baseDir, projectId);
    },
    saveDomainConfigSection(
      projectId: string,
      section: string,
      data: unknown,
      actor = "dashboard",
      saveOptions: SaveDomainConfigSectionOptions = {},
    ): ConfigWriteResult {
      return saveDomainConfigSectionAt(baseDir, projectId, section, data, actor, saveOptions);
    },
    saveDomainConfigChanges(
      projectId: string,
      updates: Record<string, unknown>,
      actor = "dashboard",
      saveOptions: SaveDomainConfigChangesOptions = {},
    ): ConfigWriteResult {
      return saveDomainConfigChangesAt(baseDir, projectId, updates, actor, saveOptions);
    },
    saveGlobalConfigSection(
      section: string,
      data: unknown,
      actor = "dashboard",
    ): ConfigWriteResult {
      return saveGlobalConfigSectionAt(baseDir, section, data, actor);
    },
    saveGlobalConfigChanges(
      updates: Record<string, unknown>,
      actor = "dashboard",
    ): ConfigWriteResult {
      return saveGlobalConfigChangesAt(baseDir, updates, actor);
    },
    updateDomainConfig(
      projectId: string,
      section: string,
      data: unknown,
      actor = "dashboard",
    ): ConfigWriteResult {
      return saveDomainConfigSectionAt(baseDir, projectId, section, data, actor);
    },
    reloadDomainRuntime(projectId: string): ConfigReloadResult {
      return reloadDomainRuntimeAt(baseDir, projectId);
    },
    reloadDomainRuntimes(projectIds: Iterable<string>): ConfigReloadResult {
      return reloadDomainRuntimesAt(baseDir, projectIds);
    },
    previewDomainConfigChange(
      projectId: string,
      updates: Record<string, unknown>,
    ): { ok: true; preview: ConfigPreviewResult } | { ok: false; error: string } {
      return previewDomainConfigChangeAt(baseDir, projectId, updates);
    },
    previewGlobalConfigChange(
      updates: Record<string, unknown>,
    ): ConfigPreviewResult {
      return previewGlobalConfigChangeAt(baseDir, updates);
    },
    previewDomainConfigSectionChange(
      projectId: string,
      section: string,
      data: unknown,
    ): { ok: true; preview: ConfigPreviewResult } | { ok: false; error: string } {
      return previewDomainConfigSectionChangeAt(baseDir, projectId, section, data);
    },
    previewGlobalConfigSectionChange(
      section: string,
      data: unknown,
    ): ConfigPreviewResult {
      return previewGlobalConfigSectionChangeAt(baseDir, section, data);
    },
    updateGlobalAgentConfig(
      agentId: string,
      updates: Record<string, unknown>,
      actor = "dashboard",
    ): { ok: boolean; error?: string } {
      return updateGlobalAgentConfigAt(baseDir, agentId, updates, actor);
    },
    createDomain(
      domainId: string,
      config: Record<string, unknown>,
    ): { ok: boolean; error?: string } {
      return createDomainAt(baseDir, domainId, config);
    },
    upsertGlobalAgents(
      agents: Record<string, GlobalAgentDef>,
      actor = "dashboard",
    ): { ok: boolean; error?: string } {
      return upsertGlobalAgentsAt(baseDir, agents, actor);
    },
    addGlobalAgent(
      agentId: string,
      agentDef: GlobalAgentDef,
      actor = "dashboard",
      force = false,
    ): GlobalAgentUpsertResult {
      return addGlobalAgentAt(baseDir, agentId, agentDef, actor, force);
    },
    addAgentToDomain(
      projectId: string,
      agentId: string,
      actor = "dashboard",
    ): ConfigWriteResult {
      return addAgentToDomainAt(baseDir, projectId, agentId, actor);
    },
    removeGlobalAgent(
      agentId: string,
      actor = "dashboard",
      removeFromDomains = false,
    ): GlobalAgentRemovalResult {
      return removeGlobalAgentAt(baseDir, agentId, actor, removeFromDomains);
    },
    deleteDomain(
      domainId: string,
      actor = "dashboard",
    ): ConfigDeleteResult {
      return deleteDomainAt(baseDir, domainId, actor);
    },
    writeDomainConfig(
      domainId: string,
      config: DomainConfig,
    ): { ok: boolean; error?: string } {
      return writeDomainConfigAt(baseDir, domainId, config);
    },
    reloadAllDomains(): { domains: string[]; errors: string[] } {
      return reloadAllDomainsAt(baseDir);
    },
  };
}

export type ConfigService = ReturnType<typeof createConfigService>;

export function readDomainConfig(projectId: string): DomainConfig | null {
  return createConfigService().readDomainConfig(projectId);
}

export function readGlobalConfig(): GlobalConfig {
  return createConfigService().readGlobalConfig();
}

export function getDomainContextDir(projectId: string): string {
  return createConfigService().getDomainContextDir(projectId);
}

export function saveDomainConfigSection(
  projectId: string,
  section: string,
  data: unknown,
  actor = "dashboard",
  options: SaveDomainConfigSectionOptions = {},
): ConfigWriteResult {
  return createConfigService().saveDomainConfigSection(projectId, section, data, actor, options);
}

export function saveDomainConfigChanges(
  projectId: string,
  updates: Record<string, unknown>,
  actor = "dashboard",
  options: SaveDomainConfigChangesOptions = {},
): ConfigWriteResult {
  return createConfigService().saveDomainConfigChanges(projectId, updates, actor, options);
}

export function saveGlobalConfigSection(
  section: string,
  data: unknown,
  actor = "dashboard",
): ConfigWriteResult {
  return createConfigService().saveGlobalConfigSection(section, data, actor);
}

export function saveGlobalConfigChanges(
  updates: Record<string, unknown>,
  actor = "dashboard",
): ConfigWriteResult {
  return createConfigService().saveGlobalConfigChanges(updates, actor);
}

export function updateDomainConfig(
  projectId: string,
  section: string,
  data: unknown,
  actor = "dashboard",
): ConfigWriteResult {
  return createConfigService().updateDomainConfig(projectId, section, data, actor);
}

export function reloadDomainRuntime(projectId: string): ConfigReloadResult {
  return createConfigService().reloadDomainRuntime(projectId);
}

export function reloadDomainRuntimes(projectIds: Iterable<string>): ConfigReloadResult {
  return createConfigService().reloadDomainRuntimes(projectIds);
}

export function previewDomainConfigChange(
  projectId: string,
  updates: Record<string, unknown>,
): { ok: true; preview: ConfigPreviewResult } | { ok: false; error: string } {
  return createConfigService().previewDomainConfigChange(projectId, updates);
}

export function previewGlobalConfigChange(
  updates: Record<string, unknown>,
): ConfigPreviewResult {
  return createConfigService().previewGlobalConfigChange(updates);
}

export function previewDomainConfigSectionChange(
  projectId: string,
  section: string,
  data: unknown,
): { ok: true; preview: ConfigPreviewResult } | { ok: false; error: string } {
  return createConfigService().previewDomainConfigSectionChange(projectId, section, data);
}

export function previewGlobalConfigSectionChange(
  section: string,
  data: unknown,
): ConfigPreviewResult {
  return createConfigService().previewGlobalConfigSectionChange(section, data);
}

export function updateGlobalAgentConfig(
  agentId: string,
  updates: Record<string, unknown>,
  actor = "dashboard",
): { ok: boolean; error?: string } {
  return createConfigService().updateGlobalAgentConfig(agentId, updates, actor);
}

export function createDomain(
  domainId: string,
  config: Record<string, unknown>,
): { ok: boolean; error?: string } {
  return createConfigService().createDomain(domainId, config);
}

export function upsertGlobalAgents(
  agents: Record<string, GlobalAgentDef>,
  actor = "dashboard",
): { ok: boolean; error?: string } {
  return createConfigService().upsertGlobalAgents(agents, actor);
}

export function addGlobalAgent(
  agentId: string,
  agentDef: GlobalAgentDef,
  actor = "dashboard",
  force = false,
): GlobalAgentUpsertResult {
  return createConfigService().addGlobalAgent(agentId, agentDef, actor, force);
}

export function addAgentToDomain(
  projectId: string,
  agentId: string,
  actor = "dashboard",
): ConfigWriteResult {
  return createConfigService().addAgentToDomain(projectId, agentId, actor);
}

export function removeGlobalAgent(
  agentId: string,
  actor = "dashboard",
  removeFromDomains = false,
): GlobalAgentRemovalResult {
  return createConfigService().removeGlobalAgent(agentId, actor, removeFromDomains);
}

export function deleteDomain(
  domainId: string,
  actor = "dashboard",
): ConfigDeleteResult {
  return createConfigService().deleteDomain(domainId, actor);
}

export function writeDomainConfig(
  domainId: string,
  config: DomainConfig,
): { ok: boolean; error?: string } {
  return createConfigService().writeDomainConfig(domainId, config);
}

export function reloadAllDomains(): { domains: string[]; errors: string[] } {
  return createConfigService().reloadAllDomains();
}
