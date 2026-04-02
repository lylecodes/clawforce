/**
 * cf org — Live Org Chart CLI
 *
 * Three subcommands:
 *   cf org              Live org tree with runtime status
 *   cf org set <agent>  Rewire reporting chain
 *   cf org check        Structural + operational audit
 *
 * Reads config.yaml + domain YAML directly (no runtime boot required).
 * DB is optional — skips runtime enrichment when unavailable.
 */

import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import YAML from "yaml";

const HOME = process.env.HOME ?? "/tmp";
const DB_DIR = path.join(HOME, ".clawforce");
const DOMAINS_DIR = path.join(DB_DIR, "domains");

// ─── Types ───────────────────────────────────────────────────────────

interface AgentEntry {
  extends?: string;
  title?: string;
  department?: string;
  team?: string;
  reports_to?: string;
  coordination?: { enabled?: boolean };
  observe?: ObserveEntry[];
  model?: string;
}

type ObserveEntry = string | {
  pattern: string;
  scope?: { team?: string; agent?: string };
};

export interface OrgOpts {
  team?: string;
  agent?: string;
}

// ─── Config helpers ──────────────────────────────────────────────────

function getGlobalConfigPath(): string {
  return path.join(DB_DIR, "config.yaml");
}

function getDomainYamlPath(domainId: string): string {
  return path.join(DOMAINS_DIR, `${domainId}.yaml`);
}

function loadAllAgents(): Record<string, AgentEntry> {
  const configPath = getGlobalConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as { agents?: Record<string, AgentEntry> };
    return parsed?.agents ?? {};
  } catch {
    return {};
  }
}

function loadDomainAgentIds(domainId: string): string[] {
  const yamlPath = getDomainYamlPath(domainId);
  if (!fs.existsSync(yamlPath)) return [];
  try {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const parsed = YAML.parse(raw) as { agents?: string[] };
    return Array.isArray(parsed?.agents) ? parsed.agents : [];
  } catch {
    return [];
  }
}

function fmt$(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function resolveRole(agent: AgentEntry): string {
  return agent.extends ?? "agent";
}

function resolveDeptTeam(agent: AgentEntry): string {
  const parts: string[] = [];
  if (agent.department) parts.push(agent.department);
  if (agent.team) parts.push(agent.team);
  return parts.length > 0 ? `[${parts.join("/")}]` : "";
}

// ─── cf org — Live Org Tree ──────────────────────────────────────────

export function cmdOrg(
  db: DatabaseSync | null,
  projectId: string,
  opts: OrgOpts,
): void {
  const allAgents = loadAllAgents();
  const domainAgentIds = loadDomainAgentIds(projectId);

  if (Object.keys(allAgents).length === 0) {
    console.error("No agents found in config.yaml");
    return;
  }

  if (domainAgentIds.length === 0) {
    console.error(`No agents found in domain: ${projectId}`);
    return;
  }

  // Filter to domain members
  const agents: Record<string, AgentEntry> = {};
  for (const id of domainAgentIds) {
    if (allAgents[id]) {
      agents[id] = allAgents[id];
    }
  }

  // Apply --team filter
  let filteredIds = new Set(Object.keys(agents));

  if (opts.team) {
    const teamAgents = new Set<string>();
    for (const [id, agent] of Object.entries(agents)) {
      if (agent.team === opts.team) {
        teamAgents.add(id);
        // Include managers up the chain
        let current = agent.reports_to;
        while (current && current !== "parent" && agents[current]) {
          teamAgents.add(current);
          current = agents[current]!.reports_to;
        }
      }
    }
    filteredIds = teamAgents;
  }

  // Apply --agent filter: show that agent's full chain (up + down)
  if (opts.agent) {
    const agentChain = new Set<string>();
    if (agents[opts.agent]) {
      agentChain.add(opts.agent);
      // Walk up
      let current = agents[opts.agent]!.reports_to;
      while (current && current !== "parent" && agents[current]) {
        agentChain.add(current);
        current = agents[current]!.reports_to;
      }
      // Walk down (all descendants)
      const addDescendants = (parentId: string) => {
        for (const [id, agent] of Object.entries(agents)) {
          if (agent.reports_to === parentId && !agentChain.has(id)) {
            agentChain.add(id);
            addDescendants(id);
          }
        }
      };
      addDescendants(opts.agent);
    }
    filteredIds = agentChain;
  }

  // Build parent -> children map
  const children: Record<string, string[]> = {};
  const rootNodes: string[] = [];

  for (const id of filteredIds) {
    const agent = agents[id]!;
    const parent = agent.reports_to;
    if (!parent || parent === "parent" || !filteredIds.has(parent)) {
      rootNodes.push(id);
    } else {
      if (!children[parent]) children[parent] = [];
      children[parent]!.push(id);
    }
  }

  // Sort root nodes and children alphabetically
  rootNodes.sort();
  for (const key of Object.keys(children)) {
    children[key]!.sort();
  }

  // ─── Runtime enrichment (optional) ─────────────────────────────────

  const activeAgents = new Set<string>();
  const agentSessionCounts: Record<string, number> = {};
  const agentCosts: Record<string, number> = {};
  const agentTasks: Record<string, Record<string, number>> = {};

  if (db) {
    try {
      // Active sessions
      const sessions = db.prepare(
        `SELECT agent_id FROM tracked_sessions
         WHERE project_id = ? AND ended_at IS NULL`,
      ).all(projectId) as Array<{ agent_id: string }>;
      for (const s of sessions) {
        activeAgents.add(s.agent_id);
        agentSessionCounts[s.agent_id] = (agentSessionCounts[s.agent_id] ?? 0) + 1;
      }
    } catch { /* DB may not have table yet */ }

    try {
      // Today's costs
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const costs = db.prepare(
        `SELECT agent_id, SUM(cost_cents) as cost
         FROM cost_records
         WHERE project_id = ? AND created_at > ?
         GROUP BY agent_id`,
      ).all(projectId, midnight.getTime()) as Array<{ agent_id: string; cost: number }>;
      for (const c of costs) {
        agentCosts[c.agent_id] = c.cost;
      }
    } catch { /* DB may not have table yet */ }

    try {
      // Task counts (non-terminal)
      const tasks = db.prepare(
        `SELECT assigned_to, state, COUNT(*) as cnt
         FROM tasks
         WHERE project_id = ? AND state NOT IN ('DONE', 'CANCELLED') AND assigned_to IS NOT NULL
         GROUP BY assigned_to, state`,
      ).all(projectId) as Array<{ assigned_to: string; state: string; cnt: number }>;
      for (const t of tasks) {
        if (!agentTasks[t.assigned_to]) agentTasks[t.assigned_to] = {};
        agentTasks[t.assigned_to]![t.state] = t.cnt;
      }
    } catch { /* DB may not have table yet */ }
  }

  // ─── Render tree ───────────────────────────────────────────────────

  console.log(`\n## ${projectId}\n`);

  const renderNode = (id: string, prefix: string, isLast: boolean, isRoot: boolean) => {
    const agent = agents[id]!;
    const role = resolveRole(agent);
    const deptTeam = resolveDeptTeam(agent);
    const isActive = activeAgents.has(id);

    // Build status string
    const statusParts: string[] = [];

    // Session status
    const sessionCount = agentSessionCounts[id] ?? 0;
    if (isActive) {
      statusParts.push(`\u25CF ${sessionCount} session${sessionCount !== 1 ? "s" : ""} today`);
    } else {
      statusParts.push("\u25CB idle");
    }

    // Cost
    const cost = agentCosts[id];
    if (cost && cost > 0) {
      statusParts.push(fmt$(cost));
    }

    // Tasks
    const tasks = agentTasks[id];
    if (tasks) {
      const taskParts: string[] = [];
      for (const [state, cnt] of Object.entries(tasks)) {
        taskParts.push(`${cnt} ${state}`);
      }
      if (taskParts.length > 0) {
        statusParts.push(taskParts.join(", "));
      }
    }

    // Build the line
    const connector = isRoot ? "\u251C\u2500" : (isLast ? "\u2514\u2500" : "\u251C\u2500");
    const titleStr = agent.title ? ` — ${agent.title}` : "";
    const roleStr = `(${role})`;
    const deptStr = deptTeam ? ` ${deptTeam}` : "";
    const statusStr = statusParts.length > 0 ? `   ${statusParts.join(" \u00B7 ")}` : "";

    const line = `${prefix}${connector} ${id} ${roleStr}${deptStr}${titleStr}${statusStr}`;
    console.log(line);

    // Observe lines for managers
    if (agent.observe && agent.observe.length > 0) {
      const childPrefix = prefix + (isRoot ? "\u2502  " : (isLast ? "   " : "\u2502  "));
      const observeDescs = formatObserveEntries(agent.observe);
      for (const desc of observeDescs) {
        const hasChildren = children[id] && children[id]!.length > 0;
        const obsConnector = hasChildren ? "\u2502  " : "   ";
        console.log(`${childPrefix}${obsConnector}\uD83D\uDC41 observes: ${desc}`);
      }
    }

    // Render children
    const kids = children[id] ?? [];
    const childPrefix = prefix + (isRoot ? "\u2502  " : (isLast ? "   " : "\u2502  "));
    for (let i = 0; i < kids.length; i++) {
      renderNode(kids[i]!, childPrefix, i === kids.length - 1, false);
    }
  };

  if (rootNodes.length === 0) {
    console.log("  (no agents in scope)");
  } else {
    for (let i = 0; i < rootNodes.length; i++) {
      renderNode(rootNodes[i]!, "", i === rootNodes.length - 1, true);
      if (i < rootNodes.length - 1) console.log("\u2502");
    }
  }

  // Quick issue count
  const issues = countIssues(agents, filteredIds);
  if (issues > 0) {
    console.log(`\n\u2570\u2500 \u26A0 ${issues} issue${issues !== 1 ? "s" : ""} (run cf org check)`);
  }

  console.log("");
}

function formatObserveEntries(entries: ObserveEntry[]): string[] {
  // Group by scope for compact display
  const scopeMap: Record<string, string[]> = {};
  for (const entry of entries) {
    if (typeof entry === "string") {
      const key = "global";
      if (!scopeMap[key]) scopeMap[key] = [];
      scopeMap[key]!.push(entry);
    } else {
      const scopeParts: string[] = [];
      if (entry.scope?.team) scopeParts.push(`team:${entry.scope.team}`);
      if (entry.scope?.agent) scopeParts.push(`agent:${entry.scope.agent}`);
      const key = scopeParts.length > 0 ? scopeParts.join(", ") : "global";
      if (!scopeMap[key]) scopeMap[key] = [];
      scopeMap[key]!.push(entry.pattern);
    }
  }

  const results: string[] = [];
  for (const [scope, patterns] of Object.entries(scopeMap)) {
    if (scope === "global") {
      results.push(`${patterns.join(", ")}`);
    } else {
      results.push(`${scope} (${patterns.join(", ")})`);
    }
  }
  return results;
}

function countIssues(agents: Record<string, AgentEntry>, filteredIds: Set<string>): number {
  let issues = 0;

  // Check for cycles
  for (const id of filteredIds) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && current !== "parent") {
      if (visited.has(current)) { issues++; break; }
      visited.add(current);
      current = agents[current]?.reports_to;
    }
  }

  // Check for missing targets
  for (const id of filteredIds) {
    const agent = agents[id]!;
    if (agent.reports_to && agent.reports_to !== "parent" && !agents[agent.reports_to]) {
      issues++;
    }
  }

  // Root nodes that aren't the only manager
  const managers = [...filteredIds].filter(id => {
    const role = resolveRole(agents[id]!);
    return role === "manager";
  });
  const rootManagers = managers.filter(id => {
    const agent = agents[id]!;
    return !agent.reports_to || agent.reports_to === "parent";
  });
  if (rootManagers.length > 1) {
    // Multiple root managers — each is a potential issue (no escalation path above them)
    issues += rootManagers.length;
  }

  // Teams without verifiers
  const teams = new Set<string>();
  const teamsWithVerifier = new Set<string>();
  for (const id of filteredIds) {
    const agent = agents[id]!;
    if (agent.team) {
      teams.add(agent.team);
      if (resolveRole(agent) === "verifier") {
        teamsWithVerifier.add(agent.team);
      }
    }
  }
  for (const team of teams) {
    if (!teamsWithVerifier.has(team)) issues++;
  }

  // Managers with 0 direct reports
  for (const id of filteredIds) {
    const agent = agents[id]!;
    if (resolveRole(agent) === "manager") {
      const hasReports = [...filteredIds].some(
        otherId => otherId !== id && agents[otherId]?.reports_to === id,
      );
      if (!hasReports) issues++;
    }
  }

  return issues;
}

// ─── cf org set ──────────────────────────────────────────────────────

export function cmdOrgSet(
  agentId: string,
  reportsTo: string,
  _opts: { yes?: boolean },
): void {
  const configPath = getGlobalConfigPath();
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(raw) as { agents?: Record<string, AgentEntry> };
  const allAgents = parsed?.agents ?? {};

  // Validate agent exists
  if (!allAgents[agentId]) {
    console.error(`Agent not found in config: ${agentId}`);
    console.error(`Available agents: ${Object.keys(allAgents).join(", ")}`);
    process.exit(1);
  }

  const clearing = reportsTo === "none";
  const targetId = clearing ? undefined : reportsTo;

  // Validate target exists (unless clearing)
  if (!clearing && !allAgents[reportsTo]) {
    console.error(`Target manager not found in config: ${reportsTo}`);
    console.error(`Available agents: ${Object.keys(allAgents).join(", ")}`);
    process.exit(1);
  }

  // Cycle detection: simulate the change and walk the chain
  if (!clearing) {
    const visited = new Set<string>();
    visited.add(agentId);
    let current: string | undefined = reportsTo;
    while (current && current !== "parent") {
      if (current === agentId) {
        console.error(`\n  \u2717 Cycle detected: setting ${agentId} → ${reportsTo} would create a reporting cycle`);
        const cyclePath = [agentId, ...visited].filter(id => id !== agentId);
        console.error(`    Chain: ${agentId} → ${reportsTo} → ... → ${agentId}`);
        process.exit(1);
      }
      if (visited.has(current)) break;
      visited.add(current);
      current = allAgents[current]?.reports_to;
    }
  }

  // Compute what's changing
  const oldReportsTo = allAgents[agentId]!.reports_to ?? "(none)";
  const newReportsTo = clearing ? "(none)" : reportsTo;

  console.log(`\n## org set\n`);
  console.log(`  ${agentId}: reports_to ${oldReportsTo} \u2192 ${newReportsTo}`);

  // Consequence preview
  if (!clearing && allAgents[reportsTo]) {
    const consequences: string[] = [];

    // Count indirect reports being added
    const countDescendants = (parentId: string): number => {
      let count = 0;
      for (const [id, agent] of Object.entries(allAgents)) {
        if (agent.reports_to === parentId) {
          count += 1 + countDescendants(id);
        }
      }
      return count;
    };
    const descendants = countDescendants(agentId);
    const totalAdded = 1 + descendants;
    consequences.push(`\u2713 Add ${totalAdded} agent${totalAdded !== 1 ? "s" : ""} to ${reportsTo}'s direct/indirect reports (${agentId}${descendants > 0 ? ` + ${descendants} reports` : ""})`);

    // Escalation routing
    consequences.push(`\u2713 Route ${agentId} escalations to ${reportsTo}`);

    // Visibility
    const targetAgent = allAgents[reportsTo]!;
    if (targetAgent.coordination?.enabled) {
      consequences.push(`\u2713 Give ${reportsTo} visibility into ${agentId}'s work via context sources`);
    }

    console.log("");
    console.log("  This will:");
    for (const c of consequences) {
      console.log(`    ${c}`);
    }
  }

  // Apply the change using YAML document manipulation (preserves comments/formatting)
  const doc = YAML.parseDocument(raw);
  if (clearing) {
    doc.deleteIn(["agents", agentId, "reports_to"]);
  } else {
    doc.setIn(["agents", agentId, "reports_to"], targetId);
  }

  fs.writeFileSync(configPath, doc.toString(), "utf-8");
  console.log(`\n  Applied. Config written to ${configPath}\n`);
}

// ─── cf org check — Structural + Operational Audit ───────────────────

export function cmdOrgCheck(
  db: DatabaseSync | null,
  projectId: string,
): void {
  const allAgents = loadAllAgents();
  const domainAgentIds = loadDomainAgentIds(projectId);

  if (Object.keys(allAgents).length === 0) {
    console.error("No agents found in config.yaml");
    return;
  }

  // Filter to domain members
  const agents: Record<string, AgentEntry> = {};
  for (const id of domainAgentIds) {
    if (allAgents[id]) {
      agents[id] = allAgents[id];
    }
  }

  const agentIds = Object.keys(agents);

  console.log(`\n## org check — ${projectId}\n`);

  let totalIssues = 0;
  const fixes: string[] = [];

  // ─── 1. Structural validation ────────────────────────────────────

  console.log("Structure:");

  // Cycle detection
  let hasCycles = false;
  for (const id of agentIds) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && current !== "parent") {
      if (visited.has(current)) {
        console.log(`  \u2717 Cycle detected involving: ${[...visited].join(" \u2192 ")} \u2192 ${current}`);
        hasCycles = true;
        totalIssues++;
        break;
      }
      visited.add(current);
      current = agents[current]?.reports_to;
      // If we walk out of domain agents, stop
      if (current && !agents[current] && current !== "parent") {
        break;
      }
    }
  }
  if (!hasCycles) {
    console.log("  \u2713 No cycles");
  }

  // Missing targets
  let missingTargets = false;
  for (const id of agentIds) {
    const agent = agents[id]!;
    if (agent.reports_to && agent.reports_to !== "parent") {
      if (!allAgents[agent.reports_to]) {
        console.log(`  \u2717 ${id} reports_to "${agent.reports_to}" which does not exist`);
        missingTargets = true;
        totalIssues++;
      } else if (!agents[agent.reports_to]) {
        console.log(`  \u26A0 ${id} reports_to "${agent.reports_to}" which is not in domain ${projectId}`);
        totalIssues++;
      }
    }
  }
  if (!missingTargets) {
    console.log("  \u2713 All reports_to targets exist");
  }

  // Chain depth
  for (const id of agentIds) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    let depth = 0;
    while (current && current !== "parent") {
      if (visited.has(current)) break;
      visited.add(current);
      current = agents[current]?.reports_to;
      depth++;
    }
    if (depth > 5) {
      console.log(`  \u26A0 Deep chain (${depth} levels) starting from ${id}`);
      totalIssues++;
    }
  }

  // Summary stats
  const teams = new Set<string>();
  const departments = new Set<string>();
  let managerCount = 0;
  for (const id of agentIds) {
    const agent = agents[id]!;
    if (agent.team) teams.add(agent.team);
    if (agent.department) departments.add(agent.department);
    if (resolveRole(agent) === "manager") managerCount++;
  }
  console.log(`  \u2713 ${teams.size} team${teams.size !== 1 ? "s" : ""}, ${agentIds.length} agents, ${managerCount} manager${managerCount !== 1 ? "s" : ""}`);

  // ─── 2. Visibility per manager ───────────────────────────────────

  console.log("\nVisibility per manager:");

  const managers = agentIds.filter(id => resolveRole(agents[id]!) === "manager");

  for (const mgrId of managers) {
    const mgr = agents[mgrId]!;

    // Find direct reports
    const directReports = agentIds.filter(id => agents[id]?.reports_to === mgrId);

    // Find all indirect reports
    const allReports = new Set<string>();
    const collectReports = (parentId: string) => {
      for (const id of agentIds) {
        if (agents[id]?.reports_to === parentId && !allReports.has(id)) {
          allReports.add(id);
          collectReports(id);
        }
      }
    };
    collectReports(mgrId);

    console.log(`  ${mgrId}:`);

    if (directReports.length > 0) {
      console.log(`    \u2713 Direct reports: ${directReports.join(", ")}`);
    } else {
      console.log(`    \u26A0 No direct reports`);
      totalIssues++;
    }

    // Check observe rules vs actual reporting — deduplicate by observed team
    if (mgr.observe && mgr.observe.length > 0) {
      const observedTeams = new Set<string>();
      for (const entry of mgr.observe) {
        if (typeof entry === "object" && entry.scope?.team) {
          observedTeams.add(entry.scope.team);
        }
      }

      if (observedTeams.size > 0) {
        for (const observedTeam of observedTeams) {
          // Find agents in that team
          const teamAgents = agentIds.filter(id => agents[id]?.team === observedTeam);
          // Check which ones are NOT in the manager's report tree
          const outsideReports = teamAgents.filter(id => !allReports.has(id) && id !== mgrId);

          if (outsideReports.length > 0) {
            // Check if any of them are managers that could be linked
            const outsideManagers = outsideReports.filter(id => resolveRole(agents[id]!) === "manager");
            const outsideWorkers = outsideReports.filter(id => resolveRole(agents[id]!) !== "manager");

            if (outsideManagers.length > 0) {
              console.log(`    \u2139 Has observe rules for team:${observedTeam} but lacks manager relationship`);
              for (const omId of outsideManagers) {
                const fix = `cf org set ${omId} --reports-to ${mgrId}`;
                console.log(`    \u2192 Fix: ${fix}`);
                fixes.push(fix);
              }
              totalIssues++;
            }
            if (outsideWorkers.length > 0) {
              console.log(`    \u2717 Cannot see: ${outsideWorkers.join(", ")} (in team:${observedTeam} but outside report tree)`);
              totalIssues++;
            }
          } else {
            console.log(`    \u2713 Observe scope team:${observedTeam} aligns with report tree`);
          }
        }
      } else {
        console.log(`    \u2713 No observe gaps`);
      }
    } else {
      console.log(`    \u2713 No observe gaps`);
    }
  }

  // ─── 3. Gap detection ────────────────────────────────────────────

  console.log("\nGaps:");

  let gapCount = 0;

  // Root nodes (managers with no reports_to who aren't the only manager)
  const rootManagers = managers.filter(id => {
    const agent = agents[id]!;
    return !agent.reports_to || agent.reports_to === "parent";
  });
  if (rootManagers.length > 1) {
    for (const id of rootManagers) {
      console.log(`  \u26A0 ${id} is a root node \u2014 escalations have no path above it`);
      gapCount++;
      totalIssues++;
    }
  }

  // Teams without verifiers
  const teamsWithVerifier = new Set<string>();
  for (const id of agentIds) {
    const agent = agents[id]!;
    if (agent.team && resolveRole(agent) === "verifier") {
      teamsWithVerifier.add(agent.team);
    }
  }
  for (const team of teams) {
    if (!teamsWithVerifier.has(team)) {
      console.log(`  \u26A0 Team "${team}" has no verifier role`);
      gapCount++;
      totalIssues++;
    }
  }

  // Orphan agents (in config but not in any domain)
  // We only check against the current domain — agents might be in other domains
  const configAgentIds = Object.keys(allAgents);
  const allDomainAgents = new Set(domainAgentIds);
  // Check if there are agents in config that aren't in any known domain
  const domainFiles = fs.existsSync(DOMAINS_DIR)
    ? fs.readdirSync(DOMAINS_DIR).filter(f => f.endsWith(".yaml") && !f.endsWith(".disabled"))
    : [];
  const allDomainMembers = new Set<string>();
  for (const file of domainFiles) {
    const ids = loadDomainAgentIds(file.replace(".yaml", ""));
    for (const id of ids) allDomainMembers.add(id);
  }
  for (const id of configAgentIds) {
    if (!allDomainMembers.has(id)) {
      console.log(`  \u26A0 "${id}" is in config.yaml but not in any active domain`);
      gapCount++;
      totalIssues++;
    }
  }

  // Managers with 0 direct reports (already checked above, but list here too)
  for (const mgrId of managers) {
    const directReports = agentIds.filter(id => agents[id]?.reports_to === mgrId);
    if (directReports.length === 0) {
      console.log(`  \u26A0 ${mgrId} is a manager with 0 direct reports`);
      gapCount++;
      totalIssues++;
    }
  }

  if (gapCount === 0) {
    console.log("  \u2713 No gaps detected");
  }

  // ─── Summary ─────────────────────────────────────────────────────

  console.log(
    `\n${totalIssues === 0 ? "\u2713 All checks passed." : `${totalIssues} issue${totalIssues !== 1 ? "s" : ""} found.`}`,
  );

  if (fixes.length > 0) {
    console.log("\nSuggested fixes:");
    for (const fix of fixes) {
      console.log(`  ${fix}`);
    }
  }

  console.log("");
}
