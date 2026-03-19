# Onboard Skill — Design Spec

## Overview

A skill that guides an agent (Claude Code or OpenClaw) through onboarding a project to ClawForce. Analyzes the project, recommends a team, creates OpenClaw agents with role-specific identity files, and generates ClawForce governance config. One-time flow per project — day-to-day management uses existing ClawForce tools.

## Flow

### Step 1: Explore Project
- Scan codebase: package.json/pyproject.toml, README, src structure, key modules
- Identify: language, framework, subsystems, infrastructure, scheduled jobs, data stores, entry points
- Summarize findings to the user

### Step 2: Ask Goal
- Ask: "What do you want agents to do?"
- Options: Ops (run/monitor), Dev (build/fix), or Both

### Step 3: Recommend Team
Based on project analysis + goal:
- Recommend a manager agent with job schedule (dispatch, reflect, ops)
- Recommend domain-specific employee agents mapped to the project's subsystems
- Recommend budget based on team size
- Present as summary: agent names, roles, what each one handles
- Opinionated defaults — human tweaks later, not during onboarding

### Step 4: Create OpenClaw Agents
- Discover existing OpenClaw agents via `openclaw agents list`
- For each recommended agent: reuse if name matches, create new if not
- Create via `openclaw agents add <name> --workspace <dir> --non-interactive`
- Copy `auth-profiles.json` from user-specified source agent (default: `main`) to each new agent's `~/.openclaw/agents/<name>/agent/`

### Step 5: Write Agent Identity Files
For each agent, write to its workspace directory:

**SOUL.md** — Tailored to the agent's role and project:
- Who they are, what they specialize in
- Their relationship to the team (who they report to)
- Project-specific context (what the project does, what their domain covers)
- Values and boundaries appropriate to the role

**AGENTS.md** — Operational guide with ClawForce-specific instructions:
- How to use ClawForce tools (clawforce_task, clawforce_log, etc.)
- How to transition tasks through the lifecycle
- How to attach evidence
- How to communicate with the manager
- Compliance expectations
- Memory strategy

**IDENTITY.md** — Pre-filled:
- Name (e.g. "qs-strategy")
- Role context
- Emoji

**USER.md** — Copied from source agent's USER.md (same human, same preferences)

**No BOOTSTRAP.md** — agents are pre-configured, skip the first-run conversation

### Step 6: Generate ClawForce Config
- `~/.clawforce/config.yaml` — global agent definitions (names, presets, titles, reporting)
- `~/.clawforce/domains/<project>.yaml` — domain-specific config:
  - Agent list
  - Budgets (project-level + per-agent)
  - Expectations per role
  - Manager jobs (dispatch/reflect/ops with cron schedules and tool scoping)
  - Policies

### Step 7: Activate
- Run ClawForce init to wire everything up
- Confirm to user: "Your team is set up. Here's what's running."

## Outputs

1. **OpenClaw agents** — created via `openclaw agents add` CLI
2. **Agent markdown files** — SOUL.md, AGENTS.md, IDENTITY.md, USER.md per agent, role-specific and project-aware
3. **ClawForce YAML config** — global config + domain config

## Embedded Knowledge

The skill must contain reference knowledge for:

### OpenClaw Agent System
- CLI: `openclaw agents add <name>`, `openclaw agents list`, `openclaw agents delete <id>`
- Agent directory structure: `~/.openclaw/agents/<name>/agent/` (auth-profiles.json, models.json)
- Workspace directory: `~/.openclaw/agents/<name>/workspace/` or custom path
- Auth profiles: `auth-profiles.json` — per-agent credentials, copied from source agent
- Session store: `~/.openclaw/agents/<name>/sessions/`

### OpenClaw Markdown Conventions
- **SOUL.md**: Personality, values, boundaries. Written in second person ("You are..."). Covers: core identity, what they care about, how they communicate, what they won't do.
- **AGENTS.md**: Operational guide. Covers: memory strategy (daily notes + MEMORY.md), tool usage, safety guidelines, communication norms.
- **IDENTITY.md**: Structured fields — name, creature_type, vibe, emoji, avatar. Machine-readable identity metadata.
- **USER.md**: Human profile — name, pronouns, timezone, preferences. Shared across agents (same human).
- **BOOTSTRAP.md**: First-run conversation starter. NOT created by this skill (agents are pre-configured).

### ClawForce Config Schema
- Presets: `manager`, `employee`, `assistant`
- Agent config: extends, title, reports_to, tools, briefing, expectations, performance_policy, jobs, observe
- Budget config: hourly/daily/monthly x cents/tokens/requests
- Job definition: cron, tools (scoped), briefing (scoped), expectations
- Built-in job presets: reflect (weekly), triage (30min), memory_review (daily)

### ClawForce Tools (per role)
- **Manager tools**: clawforce_task, clawforce_log, clawforce_ops, clawforce_compact, clawforce_message, clawforce_channel, clawforce_workflow, clawforce_goal, clawforce_verify
- **Employee tools**: clawforce_task (scoped), clawforce_log, clawforce_message, clawforce_context, clawforce_verify
- **Tool scoping**: managers get full action access, employees get filtered actions per policy

### Project Analysis Heuristics
- Map language/framework to ecosystem knowledge
- Map directory structure to subsystems (each major module = potential agent specialization)
- Map infrastructure (Docker, CI/CD, cloud) to ops agent responsibilities
- Map scheduled jobs to ClawForce cron configuration
- Map databases/APIs to agent domain knowledge requirements

## Principles

- **Opinionated defaults** — generate everything with sensible defaults, human tweaks after
- **Project-driven recommendations** — analyze the codebase, don't use rigid templates
- **Skip bootstrap** — agents are pre-configured with identity, no first-run conversation needed
- **One-time flow** — onboarding runs once per project. Day-to-day management uses ClawForce tools via the user's main agent on their normal channel (Telegram, Slack, etc.)
- **Reuse existing agents** — discover what's already in OpenClaw before creating new ones
- **Copy auth** — new agents inherit credentials from a source agent, no manual key setup
