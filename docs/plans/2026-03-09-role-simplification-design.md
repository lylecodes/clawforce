# Phase 6: Role Simplification — Config Inheritance

## Goal

Replace the hardcoded role enum (`manager | employee | scheduled | assistant`) with a config inheritance system. Agents and jobs use `extends:` to inherit from builtin or user-defined presets. All behavior flows from resolved config — no role-specific code paths.

## Architecture

The role enum is deleted. Two builtin presets ship with the system: `manager` and `employee`. Users define custom presets in their project config. Agents declare `extends: <preset-or-agent>` instead of `role: <enum>`. Config resolution walks the inheritance chain, merging fields with last-wins semantics. Array fields support `+`/`-` merge operators for append/remove without full replacement.

The same model applies to jobs — builtin job presets (`reflect`, `triage`) and user-defined job presets, composed the same way.

## Config Inheritance Model

### Resolution order (last wins)

```
builtin preset → user preset → agent config → job override (per-session)
```

### Merge rules

- **Scalars** (strings, numbers, booleans): child replaces parent
- **Objects** (performance_policy, coordination): deep merge, child keys override parent keys
- **Arrays** (briefing, skills, expectations):
  - Plain array = full replace
  - Items prefixed with `+` = append to parent's array
  - Items prefixed with `-` = remove from parent's array
  - Mix allowed: `["+new-thing", "-old-thing"]`

### Cycle detection

Walk the `extends` chain at config load time. Error if cycle detected. No depth limit.

### Example

```yaml
presets:
  sales-rep:
    extends: employee
    briefing: [soul, assigned_task, pending_messages, memory, skill]
    skills: [lead-gen, crm-integration]
    performance_policy: { action: retry, max_retries: 2, then: alert }

agents:
  sales-manager:
    extends: manager
    title: VP Sales

  rep-west:
    extends: sales-rep
    title: West Coast Rep
    reports_to: sales-manager
    skills: ["+cold-calling"]

  rep-enterprise:
    extends: sales-rep
    title: Enterprise Rep
    reports_to: sales-manager
    skills: ["+enterprise-contracts", "-crm-integration"]
```

## Builtin Agent Presets

### `manager`

- Briefing: soul, tools_reference, project_md, task_board, goal_hierarchy, escalations, team_status, trust_scores, cost_summary, resources, pending_messages, channel_messages, memory, skill (full operational context)
- Expectations: clawforce_log (write, ≥1), clawforce_compact (update_doc, ≥1)
- Performance policy: `{ action: alert }`
- Compaction: enabled
- Coordination: `{ enabled: true, schedule: "*/30 * * * *" }`
- Tools: all (`"*"`)

### `employee`

- Briefing: soul, tools_reference, assigned_task, pending_messages, channel_messages, memory, skill (task-focused)
- Expectations: clawforce_task (transition, ≥1), clawforce_log (write, ≥1)
- Performance policy: `{ action: retry, max_retries: 3, then: alert }`
- Compaction: disabled
- Coordination: `{ enabled: false }`
- Tools: scoped to task operations

### Removed roles

- **`scheduled`** — replaced by employee + job overrides or a user preset with minimal briefing and aggressive failure policy
- **`assistant`** — replaced by user preset: `extends: employee`, `expectations: []`, `compaction: true`

## Builtin Job Presets

### `reflect`

Strategic thinking time for managers.

```yaml
reflect:
  cron: "0 9 * * MON"
  briefing: [team_performance, cost_summary, velocity, trust_scores]
  nudge: "Review team performance. Consider: budget rebalancing, agent hiring/splitting, skill gaps, initiative reprioritization."
  performance_policy: { action: alert }
```

### `triage`

Coordination cycle — check on team, handle escalations.

```yaml
triage:
  cron: "*/30 * * * *"
  briefing: [task_board, escalations, pending_messages]
  nudge: "Check on your team. Reassign stuck tasks, handle escalations."
```

### Job preset usage

```yaml
agents:
  eng-lead:
    extends: manager
    jobs:
      weekly-review:
        extends: reflect
        cron: "0 9 * * FRI"
        briefing: ["+initiative_progress"]
      morning-check:
        extends: triage
        cron: "0 8 * * MON-FRI"
```

Job presets and agent presets live in separate namespaces. `extends:` in a job context resolves from job presets; in an agent context, from agent presets.

## Migration

Hard cut — `role:` field removed, `extends:` required.

| Old config | New config |
|---|---|
| `role: manager` | `extends: manager` |
| `role: employee` | `extends: employee` |
| `role: scheduled` | `extends: employee` + job overrides |
| `role: assistant` | User preset with `extends: employee`, `expectations: []`, `compaction: true` |

Config validator errors on `role:` with a clear migration message.

## Code Changes

### Eliminate role enum checks

| Current check | Replaced by |
|---|---|
| `role === "manager"` for context assembly | Resolved briefing sources from config |
| `role === "manager"` for cron registration | `config.coordination?.enabled` |
| `role === "scheduled"` for job detection | Jobs system (already works without role check) |
| `role === "assistant"` for expectations skip | `config.expectations.length === 0` |
| `BUILTIN_PROFILES[role]` lookup | `resolvePreset(config.extends)` |

### New module: `src/presets.ts`

- Builtin agent presets and job presets
- `resolveAgentConfig(config, userPresets)` — walks extends chain, merges, returns fully resolved config
- `resolveJobConfig(jobConfig, jobPresets)` — same for jobs
- Array merge operator logic (`+`/`-`)
- Cycle detection

### Type changes

- `AgentRole` type deleted
- `AgentConfig.role` → `AgentConfig.extends`
- New types: `PresetConfig`, `JobPresetConfig`, `ResolvedAgentConfig`

## Future Dependencies

- **Phase 7.4 (autonomous scheduling):** Budget-driven job allocation — manager decides dispatch cadence based on budget. Out of scope here but builds on the job preset system.
- **Preset packs / community sharing:** The preset model naturally extends to importable preset packages. Future feature, zero extra work needed now.
