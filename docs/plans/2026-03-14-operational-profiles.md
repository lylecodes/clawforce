# Operational Profiles — Implementation Plan

> Design: docs/plans/2026-03-14-operational-profiles-design.md
> Date: 2026-03-14

## Summary

Add operational profile system that lets users pick a single level (low/medium/high/ultra) to configure all operational knobs. Includes cost preview engine, wizard integration, and config validation.

## Tasks

### 1. Types (src/types.ts)
Add `OperationalProfile`, `OperationalProfileConfig`, and cost preview types (`CostBucket`, `CostLineItem`, `ProfileCostEstimate`, `ProfileRecommendation`).

### 2. Profile Definitions + Expansion (src/profiles/operational.ts)
- `PROFILE_DEFINITIONS` — static config for each profile level
- `expandProfile(profile)` — returns `OperationalProfileConfig`
- `normalizeDomainProfile(domain, global)` — pure config transformation that applies profile to agent configs, respecting per-agent overrides

### 3. Cost Preview Engine (src/profiles/cost-preview.ts)
- `CYCLE_COST_MULTIPLIER` — 1.0 for isolated, 0.2 for persistent
- `estimateProfileCost(profile, agents)` — three-bucket cost breakdown
- `recommendProfile(teamSize, budgetCents, agentRoles?)` — pick highest profile that fits within budget with 30% headroom

### 4. Domain Config Integration (src/config/schema.ts)
Add explicit `operational_profile?: OperationalProfile` field to `DomainConfig`.

### 5. Init Flow Integration (src/config/init.ts)
Call `normalizeDomainProfile()` during domain initialization, before building WorkforceConfig.

### 6. Wizard Integration
- `src/config/init-flow.ts` — add operational_profile question, add to InitAnswers, update buildConfigFromAnswers
- `src/config/wizard.ts` — add operational_profile to InitDomainOpts

### 7. Config Validation (src/config-validator.ts)
Validate `operational_profile` field on DomainConfig in `validateDomainQuality()`.

### 8. Exports (src/index.ts)
Export new modules and types.

## Commit Plan

1. Types + tests
2. Profile definitions + expansion + tests
3. Cost preview engine + tests
4. Config schema + init + wizard + validator integration + tests
5. Exports

## TDD approach

Each task: write tests first → verify fail → implement → verify pass → commit.
