# Operator Comms

Operator comms is the messaging surface inside the ClawForce governance plane.

It is not a separate chat product. It is the audited operator channel for:

- user to lead or dashboard assistant communication
- explicit user to agent intervention
- visibility into queued vs delivered operator messages
- linking operator requests to proposals and governed work

## Product Stance

Default direct communication is:

- user ↔ dashboard assistant target
- user ↔ root lead when no explicit assistant target is configured

Explicit `@agent-id` routing is supported for direct intervention.

Channels and meetings remain the place for multi-party agent coordination.
Decision inbox remains the place for approvals and human-required review.
Normal operator chat should not become the approval queue.

For Codex users, the split is:

- Codex is the primary conversational surface
- the dashboard is the visual control plane

Both surfaces should operate on the same comms backend so the operator can talk
in Codex and inspect the result in the UI without divergence.

## Delivery Model

Operator chat uses one delivery rule:

- if a live session is available, inject into the live session
- otherwise, store the message for next briefing

This applies to both the dashboard assistant route and explicit direct messages.

Supported outcomes:

- `live`
- `stored`
- `unavailable`

## UI Model

The dashboard should expose four related surfaces:

- `Operator Chat`: default user composer for the current domain
- `Comms`: direct operator threads, agent threads, and channel threads
- `Decision Inbox`: approvals and human-required action only
- `Context Panel`: linked task, proposal, goal, or session for the selected thread

Expected routing behavior:

1. Plain text in Operator Chat routes to the configured assistant target or root lead.
2. `@agent-id message` routes directly to that agent.
3. The UI shows whether delivery was live or stored.
4. Replies to `user` appear in the same direct thread/inbox.
5. Proposal-linked messages surface both in comms and in the decision context.

## Backend Contract

### Read routes

- `GET /clawforce/api/:domain/assistant`
  Returns assistant routing status for the domain, including resolved lead/assistant target and delivery policy.
- `GET /clawforce/api/:domain/operator-comms`
  Returns operator-thread summaries, inbox counts, queued counts, assistant status, and decision-inbox counts.
- `GET /clawforce/api/:domain/inbox`
  Returns raw messages to/from the `user` pseudo-agent.

### Write routes

- `POST /clawforce/api/:domain/messages/operator`
  JSON operator-chat route for the dashboard shell and other non-SSE clients.
- `POST /clawforce/api/:domain/agents/clawforce-assistant/message`
  SSE-friendly assistant/widget route.
- `POST /clawforce/api/:domain/messages/send`
  Direct message send route when the caller already knows the exact target agent.

### Key response shapes

`GET /assistant` returns:

- whether assistant routing is enabled
- the configured assistant target, if any
- the resolved default target for plain operator chat
- delivery policy
- whether direct `@agent-id` mentions are supported

`GET /operator-comms` returns:

- assistant status
- direct operator thread summaries
- inbox and unread counts
- queued-for-agent counts
- decision-inbox counts
- whether channels are configured

`POST /messages/operator` returns:

- `delivery`
- `acknowledgement`
- stored message metadata when a message was persisted

## Current Implementation

The current backend implementation is centered on these files:

- [src/app/queries/dashboard-assistant.ts](/Users/lylejens/workplace/clawforce/src/app/queries/dashboard-assistant.ts:1)
- [src/dashboard/queries.ts](/Users/lylejens/workplace/clawforce/src/dashboard/queries.ts:2660)
- [src/app/queries/dashboard-read-router.ts](/Users/lylejens/workplace/clawforce/src/app/queries/dashboard-read-router.ts:1)
- [src/dashboard/gateway-routes.ts](/Users/lylejens/workplace/clawforce/src/dashboard/gateway-routes.ts:1)
- [src/app/commands/operator-messages.ts](/Users/lylejens/workplace/clawforce/src/app/commands/operator-messages.ts:1)

The current dashboard repo in this workspace provides the backend contract and
static hosting glue. A richer SPA can be layered on top of these routes without
changing the operator messaging model.
