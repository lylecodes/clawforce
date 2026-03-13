/**
 * Clawforce — Global config and domain loader
 *
 * Reads global config and domain-level YAML files from disk,
 * validates them against the schema, and provides path-based
 * domain resolution.
 */

import YAML from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { GlobalConfig, DomainConfig } from "./schema.js";
import { validateGlobalConfig, validateDomainConfig } from "./schema.js";
import { safeLog } from "../diagnostics.js";

/**
 * Load the global config from `{baseDir}/config.yaml`.
 * Returns a default empty config if the file does not exist.
 * Throws if the file exists but contains invalid YAML or fails validation.
 */
export function loadGlobalConfig(baseDir: string): GlobalConfig {
  const configPath = path.join(baseDir, "config.yaml");

  if (!fs.existsSync(configPath)) {
    return { agents: {} };
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(raw);

  const result = validateGlobalConfig(parsed);
  if (!result.valid) {
    const details = result.errors
      .map((e) => `${e.field}: ${e.message}`)
      .join("; ");
    throw new Error(`Invalid global config at ${configPath}: ${details}`);
  }

  return parsed as GlobalConfig;
}

/**
 * Load all domain config files from `{baseDir}/domains/*.yaml`.
 * Returns an empty array if the domains directory does not exist.
 * Skips individual files that fail parsing or validation (logs a warning).
 */
export function loadAllDomains(baseDir: string): DomainConfig[] {
  const domainsDir = path.join(baseDir, "domains");

  if (!fs.existsSync(domainsDir)) {
    return [];
  }

  const files = fs
    .readdirSync(domainsDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();

  const domains: DomainConfig[] = [];

  for (const file of files) {
    const filePath = path.join(domainsDir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = YAML.parse(raw);

      const result = validateDomainConfig(parsed);
      if (!result.valid) {
        const details = result.errors
          .map((e) => `${e.field}: ${e.message}`)
          .join("; ");
        safeLog(
          "config.loader",
          `Skipping invalid domain config ${file}: ${details}`,
        );
        continue;
      }

      domains.push(parsed as DomainConfig);
    } catch (err) {
      safeLog("config.loader", err);
    }
  }

  return domains;
}

/**
 * Resolve a working directory to a domain name by matching against
 * each domain's `paths` array. Tilde (~) is expanded to the user's
 * home directory. Longer path prefixes are checked first for specificity.
 */
export function resolveDomainFromPath(
  workingDir: string,
  domains: DomainConfig[],
): string | null {
  const homeDir = os.homedir();

  // Build a flat list of (resolvedPath, domainName) pairs
  const entries: Array<{ resolved: string; domain: string }> = [];

  for (const domain of domains) {
    if (!domain.paths) continue;
    for (const p of domain.paths) {
      const resolved = p.startsWith("~")
        ? path.join(homeDir, p.slice(1))
        : p;
      entries.push({ resolved, domain: domain.domain });
    }
  }

  // Sort by path length descending so longer (more specific) prefixes match first
  entries.sort((a, b) => b.resolved.length - a.resolved.length);

  for (const entry of entries) {
    if (workingDir.startsWith(entry.resolved)) {
      return entry.domain;
    }
  }

  return null;
}

/**
 * Validate that every agent referenced in a domain config is defined
 * in the global config. Returns an array of warning strings for any
 * agents that are missing.
 */
export function validateDomainAgents(
  global: GlobalConfig,
  domain: DomainConfig,
): string[] {
  const warnings: string[] = [];

  for (const agentName of domain.agents) {
    if (!(agentName in global.agents)) {
      warnings.push(
        `Agent '${agentName}' in domain '${domain.domain}' is not defined in global config`,
      );
    }
  }

  return warnings;
}
