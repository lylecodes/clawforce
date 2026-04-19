# ClawForce Foundation, Direction, And Idea Tracker

> Last updated: 2026-04-17
> Purpose: keep product thesis, foundation work, proof lanes, and expansion ideas separated so ClawForce does not drift into random implementation churn.

## Blunt Status

ClawForce is not on the wrong product.

It is still at risk of working on the wrong layer.

The core idea is good:

- governance and control plane for agent systems
- budget control across direct API spend and subscription-backed usage
- approvals and verification at real decision boundaries
- operator metrics, audit, and intervention
- runtime-agnostic governance above the execution layer

The current risk is not "bad idea."
The current risk is:

- mixing foundation work with proving-lane implementation
- expanding setup/productization before runtime honesty is boring
- turning every good dogfood insight into a new product surface immediately

## Product Thesis

ClawForce should be the backbone for agentic systems where the operator needs:

- budget enforcement
- usage visibility
- verification and review
- approval boundaries
- durable task and workflow state
- trust / earned autonomy
- auditability and recovery

It should work whether execution happens through:

- direct Codex-style execution
- another runtime in overlay mode
- a tighter first-party mode where ClawForce owns more of the execution envelope

It should not drift into being:

- another generic workflow builder
- another agent runtime
- a low-code studio first
- a repo-mapping novelty product

## What "Foundation" Means

The foundation is not "every primitive exists."

The foundation is solid when these are true:

1. Core semantics are transport-independent.
2. Config has one canonical meaning.
3. Runtime behavior is honest after config changes.
4. The operator can live out of one primary surface.
5. Approval and verification boundaries are real and legible.
6. Dogfood lanes expose product truth instead of adapter accidents.

## Current Foundation Gaps

These are still foundation problems, not optional polish:

### 1. Runtime Honesty

- config writes must have an obvious runtime effect
- long-lived controllers must reload honestly, or the system must say restart is required
- no magical "it probably applied" behavior

### 2. Canonical Operator Surface

- one feed the operator can actually live in
- decision inbox must stay narrow and high-signal
- tasks, issues, proposals, approvals, and messages must map into one operator truth

### 3. Setup Explainability

- setup must explain why a workflow is blocked
- setup must explain what config caused a surfaced item
- setup must explain what recurring jobs and agents are missing

### 4. Simulation / Preflight

- before go-live, ClawForce should answer what it would do if an event occurs
- operators should not need to discover workflow gaps only after live mutations

### 5. Workflow Mutation As A First-Class Loop

- repeated unsupported operator work should become structured mutation proposals
- the system should evolve workflows through governed changes, not folklore

## What Is Not Foundation

These may be good ideas, but they are not the current foundation:

- repo cartography as a polished product surface
- broad autonomous workflow discovery for every codebase
- local-model swarms for mapping everything
- advanced workflow generation beyond a few canonical starter shapes
- ambitious extension ecosystems before the base operator loop is boring

Those belong to proving lanes or stretch goals unless they directly close a foundation gap.

## Proof Lanes

Proof lanes are not scope drift.
They are how ClawForce proves the foundation on real workloads.

Use proof lanes to validate:

- setup truth
- runtime honesty
- approval boundaries
- operator feed quality
- workflow mutation needs

Current proof-lane shape:

- one runtime/control-plane dogfood lane
- one setup-surface dogfood lane

The lane should stay narrow and evidence-producing.
It should not redefine the whole product.

## Idea Inventory

Track ideas by bucket, not by excitement level.

### Bucket A: Foundation Now

- controller reload honesty / restart honesty
- canonical operator feed and decision inbox
- setup validate / explain completeness
- simulation / preflight of workflow outcomes
- structured workflow-mutation proposals
- clearer verification and approval semantics

### Bucket B: Productizing The Current Path

- more starter workflow templates
- stronger setup scaffolding
- better setup status around runtime readiness
- declarative runtime choice surface
- cleaner metrics and budget views for operators
- stronger stable API / advanced / internal boundary

### Bucket C: Stretch Ideas Worth Preserving

- onboarding cartographer that maps a project and infers candidate workflows
- local-model scanning passes for cheap repo structure extraction
- higher-level reviewer that consolidates the project map into ClawForce scaffolding
- workflow drift detection against the current codebase
- automatic workflow evolution proposals based on repeated rollout pain

## How To Treat The Cartographer Idea

The onboarding/cartography idea is good.

But it should be framed correctly:

- not "this is the product"
- not "this narrows ClawForce to software repos"
- not "we need this before the foundation is real"

Instead:

- it is a setup-surface proving and productization idea
- it becomes powerful only when setup explainability, dry-run simulation, and operator review already work
- the first implementation should target one or two canonical app shapes and emit evidence-backed workflow suggestions

That keeps it broad enough to support the thesis while preventing it from hijacking the roadmap.

## Working Rules

When a new idea appears, ask:

1. Does this close a foundation gap?
2. Does this prove the product on a real lane?
3. Does this only make sense after the first two are already boring?

If the answer is:

- yes to 1: do it now
- no to 1 but yes to 2: keep it as a proof-lane implementation
- only yes to 3: track it as stretch, do not let it steal cycles

## Near-Term Goals

### Goal 1: Make The Foundation Honest

Hit these before widening scope:

- config apply is honest
- controller/runtime state is legible
- operator feed is canonical
- approvals and verification are high-signal

### Goal 2: Prove ClawForce On Real Work

- keep one runtime/control-plane lane active
- keep one setup-surface lane active
- use them to generate evidence, not vibes

### Goal 3: Productize The Winning Path

- make setup self-serve
- make starter workflows legible
- make runtime choice explicit
- make the operator experience good enough that people stop checking internals

## Execution Board

The strict execution order now lives in:

- [2026-04-18-foundation-execution-board.md](/Users/lylejens/workplace/clawforce/docs/plans/2026-04-18-foundation-execution-board.md)

Use that document for:

- `Now / Next / After That` phase ordering
- stop rules
- dedicated operator-led UI dogfood
- the anti-special-casing rule for real-app dogfood

## Anti-Churn Reminder

If it feels like "I keep doing implementations of ClawForce," that is a sign the direction and priority stack are not being enforced hard enough.

The fix is not to stop building.
The fix is to classify every build:

- foundation
- proof lane
- stretch

and reject work that pretends to be one while actually being another.
