# ClawForce Positioning

> Last updated: 2026-04-16

## Category

ClawForce is the governance and control plane for agent teams: budgets,
approvals, trust, audit, and operator control above any runtime.

It is not primarily an agent-construction framework, a workflow canvas, or a
model-specific runtime. Its job is to make long-running agent work governable.

## Product Thesis

Most agent systems optimize for one of these:

- building an agent quickly
- improving raw task capability
- exposing tools, memory, and workflows
- deploying agent APIs and sandboxes

ClawForce optimizes for a different problem:

- who is allowed to do what
- how work is approved, verified, and audited
- how budgets are enforced
- how teams are coordinated over time
- how operators intervene when systems drift or fail

The durable value is not "better prompts" or "better loops." It is governed
execution that an operator can actually trust.

## What ClawForce Owns

ClawForce should own the organizational and operational layer:

- task lifecycle and review semantics
- budgets, pacing, reservations, and circuit breaking
- trust scoring and earned autonomy
- approval policies and human escalation
- org structure, roles, reporting lines, and coordination jobs
- event routing, recovery, replay, and audit history
- operator controls, visibility, and control-plane UX

These are the surfaces that should feel first-class and harder to find
elsewhere.

## What ClawForce Does Not Need To Own

ClawForce does not need to be the best system for:

- model-native tool calling
- agent prompting patterns and planning loops
- multimodal interaction
- sandboxed code execution
- low-code or no-code app building
- benchmark chasing for general agent capability

Those are runtime concerns. ClawForce should compose with strong runtimes rather
than duplicating them.

## Runtime Boundary

The intended boundary is:

- runtime/framework owns agent execution
- ClawForce owns governance and control

In practice that means:

- runtimes own tool sandboxes, model APIs, memory primitives, and agent loops
- ClawForce owns budgets, approvals, work state, review gates, trust, recovery,
  and operator-facing control

## Two-Layer Agent Model

To make that boundary real, ClawForce should treat an "agent" as two related
things:

- a governed worker identity owned by ClawForce
- an execution profile owned by the runtime

The ClawForce side should carry the durable organizational record:

- stable agent ID
- role / preset / mixins
- title and persona
- reporting chain, department, and team
- briefing, expectations, and coordination jobs
- budgets, trust, permissions, approval policy, and compliance state
- capability tags used for assignment, routing, or risk decisions

The runtime side should carry the executable profile:

- model and provider
- concrete tool wiring and sandbox rules
- workspace mounting and session bootstrap details
- memory backend, compaction mechanics, and loop settings
- multimodal, streaming, deployment, and service-specific runtime settings

The same logical worker can exist in both systems, but ClawForce should not try
to become the canonical source of truth for the full runtime agent definition.
It should bind to a runtime agent by ID or adapter reference and govern the work
that agent performs.

### Ambiguous Fields

Some fields look shared but should be split by meaning:

- ClawForce may keep capability declarations when they affect assignment,
  approval, or policy
- the runtime should own the concrete runnable tool configuration
- ClawForce may request a model override at the job or task level as a
  governance decision
- the runtime should still own the base model configuration for the agent

### Direct Execution Case

When ClawForce executes directly through Codex and there is no external runtime
registry, it may still need a minimal execution profile. That is acceptable, but
it should live in adapter- or executor-specific config, not in the core
organizational identity model.

## Canonical Start Path

The docs should push one primary start path:

1. direct Codex execution
2. new domains start in `dry_run`
3. the operator uses the dashboard as the primary control plane
4. Codex remains the primary conversational surface
5. `live` is a deliberate promotion step once the system is boring and honest

Bring-your-own-runtime adoption is still important, but it should read as the
second story, not the first story.

## Product Modes

ClawForce should support three clear product modes:

### 1. Overlay Mode

Use this when a team already has agents modeled in another runtime such as
OpenClaw or AgentScope.

- the runtime remains source of truth for prompt, tools, model, bootstrap, and
  memory behavior
- ClawForce injects governance context and enforces budget, approval, trust,
  task, and audit policy around the run
- adoption cost stays low because users do not need to migrate their whole
  agent stack first

This should be the default story for bring-your-own-runtime users.

### 2. Hybrid Mode

Use this when teams want shared ownership.

- the runtime still owns execution primitives
- ClawForce owns more of the governed prompt layer, role structure, and
  coordination behavior
- some runtime settings may still be mirrored or overridden intentionally

This mode is useful during migration, but it should be treated as an explicit
middle state, not a blurry default.

### 3. ClawForce-Owned Mode

Use this when ClawForce is the primary execution surface, such as direct Codex
dispatch.

- ClawForce owns the governance layer
- ClawForce also carries the minimal execution profile needed to run work
- this can deliver the most integrated experience, but it is not the right
  assumption for users bringing an existing runtime

The strategic default should be:

- overlay first for external runtimes
- ClawForce-owned first for direct Codex execution
- hybrid only when there is a deliberate reason to share ownership

## Relationship To Other Agent Systems

ClawForce should be positioned as complementary to systems such as:

- AgentScope / AgentScope Runtime
- Qwen-Agent
- Spring AI Alibaba
- Youtu-Agent
- MS-Agent
- Coze Studio

Those systems mostly help users build or run agents.

ClawForce should help users govern them.

## Honest Current State

The product direction is broader than the current adapter surface.

Today, ClawForce is:

- Codex/OpenAI-first by default
- optionally integrated with OpenClaw
- still carrying Claude Code compatibility paths

In the current codebase, some runtime-shaped fields still leak through the agent
config and OpenClaw sync path. That should be treated as transition-state
reality, not the long-term model contract.

The first concrete bridge toward this model is now:

- runtime-owned agents can be bound with `runtimeRef`
- OpenClaw exposes an explicit `integrationMode`
- OpenClaw still defaults to `hybrid` today for backward compatibility
- `overlay` remains the recommended target posture for bring-your-own-runtime
  users

So the positioning should be:

- framework-agnostic in thesis
- selectively integrated in product reality

We should not overclaim broad runtime interoperability until adapters exist and
are supported end to end.

The only runtime stories that should be documented as product-real in start-here
docs are:

- direct Codex execution
- OpenClaw as an optional compatibility bridge
- legacy Claude Code only as compatibility, not as a growth story

## Design Center

The primary user is a solo technical operator running real agent work over time,
not someone trying to demo an agent in five minutes.

Internal platform teams and product or ops leads are important follow-on
audiences, but the design center should stay with the operator who can actually
wire the runtime, budgets, approvals, and rollout path.

Design for:

- teams, not just single agents
- recurring work, not only one-shot chats
- budgets and risk, not just task success
- operators, not only developers
- auditability and recovery, not only nominal-path execution

## Canonical Use Cases

The first two doc-anchoring use cases should be:

- governed coding-agent teams
- onboarding or ops pipelines that need staged rollout, approvals, and audit

Those are the clearest places where ClawForce's governance value is visible
early.

## First Proof

The first proof point for skeptical readers should be budget enforcement.

It is the clearest way to show that ClawForce is not just helping agents act; it
is constraining how a team is allowed to operate. Operator visibility and audit
should land immediately after that.

## Direction

ClawForce should move further toward:

1. being the best governance/control plane for agent organizations
2. proving governance value with measurable operational outcomes
3. integrating with external runtimes instead of replacing them
4. making operator workflows first-class in both CLI and dashboard

## Anti-Goals

ClawForce should not drift into:

- becoming another generic agent SDK
- becoming a prompt-library product
- becoming a low-code workflow studio first
- owning runtime concerns that stronger runtimes already solve better
- hiding core governance behavior behind implicit or unaudited magic

## Strategic Test

A good ClawForce decision should make this sentence more true:

"Use your preferred agent runtime for execution, and use ClawForce to govern
the team that runs on top of it."
