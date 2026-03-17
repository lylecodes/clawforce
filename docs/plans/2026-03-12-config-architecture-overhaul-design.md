# Phase 9: Config & Architecture Overhaul — Design

## Product Vision

Clawforce is the product. OpenClaw is invisible infrastructure. Users configure everything through Clawforce and never touch OpenClaw directly.

## Core Principles

1. **Orchestration = deterministic engine + prompt builder.** LLM spend only where rules don't exist.
2. **Agents are global, domains are assignments.** Agents defined once, work across domains.
3. **Rules are pre-built prompt templates.** Decisions codified as trigger + template = no LLM cost.
4. **The system evolves.** Analytical decisions promote to rules over time via the promotion pipeline.

## 1. Global Domain Config Architecture

### Directory Structure

```
~/.clawforce/
  config.yaml                <- global settings + agent roster
  domains/
    rentright.yaml           <- domain config
    quantscape.yaml
    lifeos.yaml
  data/
    rentright.db             <- per-domain database
    quantscape.db
```

### Global Config (`config.yaml`)

```yaml
defaults:
  model: anthropic/claude-opus-4-6
  performance_policy:
    action: retry
    max_retries: 3
    then: alert

agents:
  lyle-pa:
    extends: orchestrator
    model: anthropic/claude-opus-4-6
  compliance-bot:
    extends: employee
  research-bot:
    extends: employee
  strategy-agent:
    extends: employee
```

### Domain Config (`domains/<name>.yaml`)

```yaml
domain: rentright
orchestrator: lyle-pa
paths:
  - ~/workplace/rentright-api
  - ~/workplace/rentright-web
agents:
  - compliance-bot
  - research-bot
policies:
  approval_required: ["shell", "file_write"]
budget:
  daily: $5.00
workflows:
  - plan_execute_verify
rules:
  - name: deploy-review
    trigger:
      event: task.completed
      match: { tags: ["deploy"] }
    action:
      agent: compliance-bot
      prompt_template: |
        Review the deployment for {{task.title}}.
        Check: security scan passed, tests green, changelog updated.
```

### Key Design Decisions

- Agents defined globally, assigned to domains
- An agent can appear in multiple domains
- Each domain has one orchestrator
- Domain-level config overrides global defaults
- Domains without `paths` are valid (non-code initiatives)
- Working directory -> domain resolution via path prefix matching
- Per-domain SQLite databases in `~/.clawforce/data/`

## 2. Three-Layer Execution Model

```
Layer 1: Deterministic Engine (free, fast)
  - Trigger evaluation (event/cron/request -> domain + agent)
  - Budget gate (can this agent spend?)
  - Policy check (is this action allowed?)
  - Agent selection (routing rules -> best agent)
  - Prompt assembly (deterministic context gathering)

Layer 2: Prompt Builder (cheap LLM assist)
  - Task framing (how to present work to the agent)
  - Context compression (what to emphasize/trim)
  - Behavioral injection (expectations, evolution prompt)

Layer 3: Analytical Intelligence (expensive, only when needed)
  - Data-driven decisions no rule covers
  - Brainstorming, pattern recognition
  - Flags repeated decisions as rule candidates
```

### Rules = Pre-Built Prompt Templates

When a trigger fires, the deterministic engine matches the rule, fills the template variables, and dispatches. No LLM needed for the routing/scheduling/budget decision.

### Evolution Pipeline

Extends Phase 8's promotion system:
- Orchestrators receive an evolution prompt encouraging them to document judgment calls
- Repeated analytical decisions get flagged as rule candidates
- `suggestTarget` gains `"rule"` as a promotion target
- Manager reviews and approves -> rule codified into domain config
- System gets cheaper and faster over time

## 3. Init Wizard

Dual interface — programmatic API + CLI skin:

```typescript
// Programmatic (agents call this)
initDomain({
  name: "rentright",
  paths: ["~/workplace/rentright-api"],
  orchestrator: "lyle-pa",
  agents: ["compliance-bot"]
})
```

```
# Interactive CLI (humans use this)
$ clawforce init
  -> Domain name? rentright
  -> Code paths? ~/workplace/rentright-api
  -> Starting preset? [orchestrator / employee / custom]
  -> Created ~/.clawforce/domains/rentright.yaml
```

The API is the real interface. CLI wraps it with interactive prompts.

## 4. Config Quality Feedback

### Runtime Validator (enhanced)

Three tiers: `error | warn | suggest`

Suggestions are non-blocking guidance:
- "You have 3 agents but no budget config"
- "Agent X has no expectations defined"
- "Domain has no orchestrator — consider assigning one"

### Skill Topic

Updated `config` skill topic documents best practices, common pitfalls, domain structure, agent assignment patterns, budget strategy, and rule authoring.

## 5. Config Hot-Reload

File watcher on `~/.clawforce/`:
- Watches `config.yaml` and `domains/*.yaml`
- Debounce 500ms
- Re-parse, validate, diff against in-memory state
- Reject invalid changes (emit diagnostic event)
- Apply valid changes without restart

**Hot-reloadable:** agent config, domain assignments, policies, budgets, rules

**Requires restart:** adding/removing entire domains, changing domain paths

## 6. Migration from Project-Scoped System

Clean break. Replace the project-scoped config system entirely:
- `project.yaml` no longer used
- `registerWorkforceConfig(projectId, ...)` replaced with domain-based loading
- Per-project databases become per-domain databases
- All modules updated to use domain-based lookups

## What's NOT in Phase 9

Deferred to Phase 10 (Dashboard & Communication):
- SSE event streams
- Graph-based agent network visualization
- Dashboard chat with agents
- Human participation in channels/meetings
- Real-time activity display

## Approach

Clean break — no backward compatibility, no migration tool. Build the new global domain system as the only system. Rip out project-scoped config entirely.
