---
name: rentright-data-orchestrator
description: Use as the high-level router for RentRight's governed data pipeline. Classifies the incoming issue or goal, chooses the correct specialist skill, sequences the work, and decides when parallel jurisdiction work is appropriate. Triggers on "run the data org", "triage data pipeline", "orchestrate jurisdiction work", "route rentright data work".
---

# RentRight Data Orchestrator

This is a thin routing skill. It should not replace the specialist skills.

Use it to classify the problem, choose the right workflow, and decide whether work should stay sequential or be split across independent jurisdictions.

## Specialist Skills

- `../clawforce-dogfood-rollout/SKILL.md`
- `../clawforce-dogfood-experiment/SKILL.md`
- `../clawforce-workflow-steward/SKILL.md`
- `../clawforce-drill-runner/SKILL.md`
- `../rentright-org-builder/SKILL.md`
- `../rentright-source-onboarding-steward/SKILL.md`
- `../rentright-jurisdiction-onboarding/SKILL.md`
- `../rentright-bundle-verify/SKILL.md`
- `../rentright-integrity-remediation/SKILL.md`
- `../rentright-jurisdiction-memory-maintenance/SKILL.md`
- `../rentright-production-sentinel/SKILL.md`

## Routing Table

- New jurisdiction or inactive regime -> `rentright-jurisdiction-onboarding`
- New owner creation or retirement -> `rentright-org-builder`
- Source-level setup or repair -> `rentright-source-onboarding-steward`
- Blocked/flagged verdict -> `rentright-integrity-remediation`
- Release candidate or parent change -> `rentright-bundle-verify`
- Dossier drift or owner knowledge refresh -> `rentright-jurisdiction-memory-maintenance`
- Live drift, stale rates, or post-release watch -> `rentright-production-sentinel`
- Governance rollout / first activation -> `clawforce-dogfood-rollout`
- Controlled hypothesis/expected-vs-actual dogfood run -> `clawforce-dogfood-experiment`
- Recurring rollout pain or missing workflow levers -> `clawforce-workflow-steward`
- Controlled org verification -> `clawforce-drill-runner`

## Parallelism Rules

Parallel work is good when:
- jurisdictions are independent
- write scopes are separate
- verification tasks do not depend on each other

Keep work sequential when:
- a parent change affects children
- integrity remediation must finish before verification
- the next step depends on the previous result

## Process

1. Classify the issue.
2. Choose the primary specialist skill.
3. Decide whether secondary skills are needed after the first one completes.
4. Split into parallel tasks only when scopes are disjoint.
5. Keep one agent accountable for end-to-end closure of each jurisdiction task.

## Rules

- Do not turn this into a mega-skill.
- Do not assume one subagent per skill is automatically better.
- Use specialist skills for execution; use this skill for routing and sequencing.
