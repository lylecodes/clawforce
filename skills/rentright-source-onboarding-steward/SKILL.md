---
name: rentright-source-onboarding-steward
description: Use when onboarding or repairing RentRight data sources at the source/config level. Owns source eligibility, official URL selection, deterministic quote quality, extraction configuration, and handoff into the DB-first pipeline. Triggers on "add data source", "repair source config", "onboard official source", "fix extraction config", "source steward".
---

# RentRight Source Onboarding Steward

Use this skill when the problem is at the source layer rather than the jurisdiction-activation layer.

Read these first:
- `../../rentright/docs/architecture/DATA_PIPELINE.md`
- `../../rentright/docs/architecture/DATA_SOURCE_ONBOARDING.md`
- `../../rentright/docs/architecture/DATA_SOURCES.md`

## Goal

Create or repair a source so it can flow cleanly through RentRight's DB-first extraction pipeline.

## Process

1. Confirm source eligibility.
   Accept official government-hosted sources only for production onboarding.
   If research came from a third-party publisher, find the official source before proceeding.

2. Choose extraction mode.
   Pick one:
   - `api`
   - `deterministic`
   - `manual`
   - `informational`

3. Build reliable extraction config.
   For deterministic sources:
   - use long, specific `expected_value_raw`
   - avoid brittle micro-quotes
   - confirm quotes match the actual authoritative page

   For API sources:
   - validate endpoint and field mappings
   - document transforms and date semantics

4. Check temporal requirements.
   If fields are `time_boxed_rate`, require effective dates.
   If fields are not temporal, reject accidental date attachment.

5. Run extraction.
   Confirm the source writes cleanly to `extracted_values`.

6. Hand off to the next stage.
   Once the source is healthy, route into:
   - jurisdiction onboarding
   - integrity remediation
   - bundle verification
   depending on why the source work was needed

## Output

Produce:
- source eligibility verdict
- extraction method choice
- config summary
- extraction result
- handoff recommendation

## Rules

- Never use direct YAML edits to paper over source issues.
- The source steward owns source quality, not final jurisdiction promotion.
- Short or ambiguous quotes are not “good enough”.
