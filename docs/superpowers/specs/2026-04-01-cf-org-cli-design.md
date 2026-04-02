# cf org — Live Org Chart CLI

**Date:** 2026-04-01  
**Status:** Approved

## Problem

ClawForce's org structure (reports_to, department, team) determines what agents can see and do — it controls context source scoping, escalation routing, and task board filtering. But there's no CLI surface to visualize, validate, or modify it. Users must read YAML files to understand org wiring and manually edit config to change it. Worse, there's no way to see the *operational consequences* of the current structure — e.g., a manager with observe rules targeting a team they don't manage won't actually receive that team's context data.

## Solution

Three subcommands in `cf org`:

### `cf org` — Live Org Tree

Renders a tree view of the full org hierarchy, enriched with runtime data from the database.

```
clawforce-dev
│
├─ cf-lead (manager) [engineering/core]        ● 2 sessions today · $12.40
│  ├─ cf-worker (employee)                     ○ idle · 3 ASSIGNED
│  ├─ cf-worker-2 (employee)                   ○ idle · 1 IN_PROGRESS
│  ├─ cf-verifier (verifier)                   ○ idle
│  └─ 👁 observes: dashboard team (task.*, dispatch.*)
│
├─ dash-lead (manager) [engineering/dashboard] ● 1 session today · $8.20
│  ├─ dash-worker (employee)                   ○ idle · 2 ASSIGNED
│  ├─ dash-worker-2 (employee)                 ○ idle
│  └─ dash-worker-3 (employee)                 ○ idle
│
╰─ ⚠ 2 issues (run cf org check)
```

**Data sources:**
- Structure: `~/.clawforce/config.yaml` (agents map with reports_to, department, team, extends, observe)
- Domain membership: `~/.clawforce/domains/<domain>.yaml` (agents array)
- Runtime (optional, graceful if DB empty):
  - Active sessions: `tracked_sessions` table
  - Today's cost: `cost_records` table (since midnight)
  - Task counts: `tasks` table (non-terminal states, grouped by assigned_to + state)

**Filters:**
- `--team=X` — show only agents in that team + their managers
- `--agent=X` — show that agent's full chain (up to root + down to leaves)

**Tree logic:**
1. Load all agents from config.yaml
2. Filter to agents in the current domain (from domain YAML agents array)
3. Group by reports_to to build parent→children map
4. Root nodes = agents with no reports_to or reports_to: "parent"
5. Render depth-first with box-drawing characters
6. For each manager, check for `observe` config and render watch lines
7. Run quick issue detection (same as cf org check but summary only)

### `cf org set <agent> --reports-to <manager>` — Rewire Reporting

Modifies reports_to in config.yaml with a consequence preview.

```
$ cf org set dash-lead --reports-to cf-lead

  dash-lead: reports_to (none) → cf-lead

  This will:
    ✓ Give cf-lead visibility into dashboard team via context sources
    ✓ Route dash-lead escalations to cf-lead
    ✓ Add 4 agents to cf-lead's direct/indirect reports (dash-lead + 3 workers)

  Apply? [y/n]
```

**Mutation path:** Uses `loadYamlDocument()` + `doc.setIn(["agents", agentId, "reports_to"], manager)` + write. Same pattern as `cf config set`.

**Validation before apply:**
- Target manager must exist in config
- No cycles (walk the chain after hypothetical change)
- Agent must exist in config

**Consequence analysis:**
- Compute manager's direct/indirect reports before and after
- Compute visibility delta (which context sources gain/lose data)
- Compute escalation chain change
- If manager is "none" (clearing reports_to), use `--reports-to none`

### `cf org check` — Structural + Operational Audit

Full analysis of the org structure with actionable findings.

```
$ cf org check

Structure:
  ✓ No cycles
  ✓ All reports_to targets exist
  ✓ 2 teams, 9 agents, 2 managers

Visibility per manager:
  cf-lead:
    ✓ Direct reports: cf-worker, cf-worker-2, cf-verifier
    ✗ Cannot see: dash-lead, dash-worker, dash-worker-2, dash-worker-3
    ℹ Has observe rules for team:dashboard but lacks manager relationship
    → Fix: cf org set dash-lead --reports-to cf-lead

  dash-lead:
    ✓ Direct reports: dash-worker, dash-worker-2, dash-worker-3
    ✓ No observe gaps

Gaps:
  ⚠ Team "dashboard" has no verifier role
  ⚠ dash-lead is a root node — escalations have no path above it
```

**Checks performed:**

1. **Structural validation** (from existing config-validator.ts logic):
   - All reports_to targets exist
   - No cycles in escalation chains
   - Chain depth warnings (>5 levels)

2. **Visibility analysis** (new):
   - For each manager: compute direct reports via reports_to
   - For each manager with observe rules: compute which agents match the observe scope (team/department filters)
   - Flag mismatches: observe rules targeting agents outside the manager's report tree
   - Explain the consequence: "context sources X, Y won't include this data"

3. **Gap detection** (new):
   - Root nodes with no escalation path (managers with no reports_to who aren't the only manager)
   - Teams with no verifier role
   - Orphan agents (in config but not in any domain)
   - Managers with 0 direct reports

4. **Suggested fixes**: For each issue, emit the `cf org set` command that would fix it.

## Architecture

**New file:** `src/cli/org.ts`

Exports three functions consumed by the CLI switch in `src/cli.ts`:
- `cmdOrg(db: DatabaseSync | null, projectId: string, opts: OrgOpts): void`
- `cmdOrgSet(agentId: string, reportsTo: string, opts: { yes?: boolean }): void`
- `cmdOrgCheck(db: DatabaseSync | null, projectId: string): void`

**Dependencies:**
- `src/org.ts` — existing hierarchy helpers (getDirectReports, resolveEscalationChain)
- `src/project.ts` — getAgentConfig, getRegisteredAgentIds
- Config I/O — loadYamlDocument, getGlobalConfigPath (imported from cli.ts or extracted to shared util)

**DB is optional.** The tree and check commands work without a database — they just skip runtime enrichment. This means `cf org` works even before the system has ever run.

## CLI Integration

In `src/cli.ts`, add to the help text under a new "Org:" section and wire into the switch:

```
Org:
  org                         Live org tree with runtime status
  org set <agent> --reports-to <mgr>  Rewire reporting chain
  org check                   Structural + operational audit
```

The `org` and `org check` commands use the DB (optional). The `org set` command doesn't need the DB at all — it only reads/writes config.yaml.

## Testing

Key test cases:
- Tree renders correctly for flat (no reports_to), single-chain, and multi-chain orgs
- Cycle detection works and blocks mutation
- Visibility analysis correctly identifies observe/reports_to mismatches
- Consequence preview accurately diffs before/after state
- Graceful degradation when DB is unavailable or empty
- `--team` and `--agent` filters render correct subtrees
