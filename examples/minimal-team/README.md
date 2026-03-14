# Minimal Team Example

The simplest Clawforce setup — 3 agents, roles inferred from structure.

- `lead` has agents reporting to it → automatically becomes a **manager**
- `frontend` and `backend` report to lead → automatically become **employees**
- $30/day budget enforced across the team

No `extends:`, no `model`, no `briefing` — all inferred from presets.

## What happens

1. `lead` wakes on a cron, sees the task board, creates and assigns work
2. `frontend` and `backend` receive assigned tasks, execute, attach evidence
3. Compliance is tracked — if an employee doesn't complete their task, retry kicks in
4. Budget is enforced — dispatch blocks if $30/day is exceeded
5. Escalations route up: frontend fails → lead gets notified
