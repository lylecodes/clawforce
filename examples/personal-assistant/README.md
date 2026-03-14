# Personal Assistant Example

A single AI assistant with budget controls and approval gates on external actions.

## Setup

- One agent, no reporting chain (human is the authority)
- $5/day budget, $100/month cap
- Tool gates on email and calendar (require approval before sending)
- Morning briefing at 8am, evening memory review at 8pm

## What happens

1. **Morning briefing** — assistant wakes at 8am, prepares daily summary via Telegram
2. **Throughout the day** — you message the assistant via Telegram, it handles tasks
3. **Email/calendar gating** — assistant can draft emails but needs your approval to send
4. **Evening review** — memory review job extracts learnings from the day's sessions
5. **Budget** — $5/day hard limit prevents runaway costs
6. **Trust evolution** — as you approve more emails, the system suggests auto-approving routine ones
