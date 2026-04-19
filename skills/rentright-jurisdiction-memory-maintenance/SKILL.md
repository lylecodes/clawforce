---
name: rentright-jurisdiction-memory-maintenance
description: Use to maintain the long-lived memory and dossier for a RentRight jurisdiction owner. Updates trusted sources, rejected sources, quirks, scenario packs, release notes, and unresolved ambiguities without turning memory into source-of-truth data. Triggers on "update jurisdiction memory", "refresh dossier", "maintain owner memory", "jurisdiction notes".
---

# RentRight Jurisdiction Memory Maintenance

Use this skill to keep a jurisdiction owner's working memory useful without letting it drift into fake authority.

Read these first:
- `../../rentright/docs/architecture/DATA_VALIDATION_FLOW.md`
- `../../rentright/docs/architecture/DATA_SOURCE_ONBOARDING.md`

Then inspect the jurisdiction dossier:
- `../../rentright/docs/jurisdictions/<slug>/sources.md`
- `../../rentright/docs/jurisdictions/<slug>/known-quirks.md`
- `../../rentright/docs/jurisdictions/<slug>/scenario-pack.md`
- `../../rentright/docs/jurisdictions/<slug>/release-log.md`

## Goal

Keep the jurisdiction owner’s operating context current, compact, and evidence-backed.

## Process

1. Review recent change history.
   Look for:
   - new sources
   - rejected sources
   - resolved ambiguities
   - production incidents
   - scenario updates

2. Update the source map.
   Maintain:
   - authoritative sources
   - fallback/reference sources
   - rejected/problematic sources

3. Update known quirks.
   Keep only durable knowledge:
   - ordinance quirks
   - local exemption nuances
   - fiscal-cycle details
   - recurring extraction traps

4. Update scenario pack.
   Add or retire scenarios when behavior changes or regressions are discovered.

5. Update release log.
   Record only high-signal production changes and signoff notes.

6. Prune stale notes.
   Remove obsolete assumptions and temporary debugging clutter.

## Output

Produce updated dossier files and, if appropriate, a short note for the jurisdiction owner summarizing what changed.

## Rules

- Docs and DB hold canonical operational truth; memory is supporting context.
- Do not duplicate entire source quotes or generated values in dossier notes.
- Prefer compact, durable notes over narrative history.
