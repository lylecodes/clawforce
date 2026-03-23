# Config Validation Module — Design Spec

## Problem

Three classes of config errors caused runtime outages tonight:

1. **YAML syntax error** — orphaned field at wrong indentation broke all domain loading silently
2. **Preset expectation override** — manager preset injects `clawforce_log write` expectation even when agent config sets `expectations: []`. Agent gets auto-disabled for non-compliance against expectations the user removed.
3. **Uncontrollable auto-disable** — no per-agent override for consecutive failure threshold

## Solution

New module `src/config/validate.ts` that validates all config at load time, reports ALL issues at once, and catches semantic conflicts between presets, agent config, and domain defaults.

## Interface

```typescript
type ValidationSeverity = "error" | "warn" | "suggest";

type ValidationIssue = {
  severity: ValidationSeverity;
  file?: string;
  path?: string;
  agentId?: string;
  code: string;
  message: string;
};

type ValidationReport = {
  valid: boolean;
  issues: ValidationIssue[];
};

function validateAllConfigs(baseDir: string): ValidationReport;
```

## What to Validate

### YAML Structure (pre-parse)
- `YAML_PARSE_ERROR` — syntax errors
- `YAML_UNKNOWN_KEY` — top-level key not in known schema
- `YAML_DUPLICATE_KEY` — duplicate keys in same mapping

### Schema (delegates to existing validators)
- Wraps existing `validateGlobalConfig` / `validateDomainConfig`

### Semantic (new checks)
- `EXPECTATION_OVERRIDE_CONFLICT` — agent sets `expectations: []` but preset or domain defaults will inject expectations
- `AUTO_DISABLE_RISK` — agent's performance_policy + default maxConsecutiveFailures will lead to auto-disable
- `UNKNOWN_PRESET` — agent's `extends` references unknown preset
- `REPORTS_TO_UNKNOWN` — agent's `reports_to` not in same domain
- `VERIFICATION_GATE_EMPTY_COMMAND` — gate has empty command

### Cross-Config
- `DOMAIN_AGENT_NOT_GLOBAL` — domain references agent not in global config
- `ORCHESTRATOR_NOT_IN_DOMAIN` — domain's orchestrator not in its agents list
- `ORPHAN_AGENT` — agent defined globally but not in any domain

## Where to Hook

1. **Gateway startup** — call `validateAllConfigs` at top of `initializeAllDomains()` in `src/config/init.ts`. Log all issues. Non-blocking (valid domains still load).
2. **CLI** — `clawforce validate` standalone command

## Root Cause Fix

The expectation override bug: `mergeDomainDefaults` in `src/config/init.ts` appends domain default expectations unconditionally. If user set `expectations: []`, those defaults get re-added. Fix: check if agent explicitly set expectations before merging defaults.

## Critical Files
- `src/config/validate.ts` — new validation module
- `src/config/init.ts` — hook validation into `initializeAllDomains`, fix expectation merge bug
- `src/config/schema.ts` — existing schema validators (extend, don't duplicate)
- `src/config-validator.ts` — existing semantic validators (wrap into unified report)
- `src/presets.ts` — preset definitions, `resolveConfig` merge logic
