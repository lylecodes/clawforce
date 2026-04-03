# Dashboard Rebase — 17 Views → 8 Focused Views

**Date:** 2026-04-02
**Status:** Approved
**Repo:** /Users/lylejens/workplace/clawforce-dashboard

## Problem

Dashboard has 17 routes, ~half are broken or unnecessary. Views duplicate CLI output, mix governance concerns with internal debugging, and spread attention thin. Need to cut to essential governance views, fix what's broken, and let users customize which tabs they see.

## Final View List (8 views)

### 1. Command Center (`/`)
Absorbs Analytics + Sessions. Single overview with tabs/sections:
- **KPIs**: active agents, tasks in flight, budget %, system health
- **Budget**: daily cost chart (time-series), burn rate, pacing
- **Activity**: recent transitions, completions, failures feed
- **Agent Performance**: cost per agent, trust scores, session counts
- **Sessions**: paginated table (fix 1.7MB response — add limit/offset params)
- **Queue**: dispatch queue status with concurrency display

### 2. Tasks (`/tasks`)
Kanban board — fix CSS overflow so BLOCKED and DONE columns are visible.
- 7 columns: OPEN, ASSIGNED, IN_PROGRESS, REVIEW, BLOCKED, DONE, FAILED
- Task detail panel with evidence + transitions
- Drag-drop state transitions

### 3. Approvals (`/approvals`)
Fix data structure mismatch causing loading skeleton.
- 3 tabs: Pending, Approved, Rejected
- Risk-tier badges, bulk approve for low-risk
- Individual approve/reject with feedback

### 4. Org Chart (`/org`)
Fix agent filter to include dash team (all domain agents, not just engineering).
- Tree hierarchy from reports_to
- Agent detail panel on selection
- Trust scores + task assignment overlay

### 5. Comms (`/comms`)
Already working. Agent inbox + thread view + message compose.

### 6. Config (`/config`)
Already working. Domain config YAML editor + context file editor.
- Config versioning + preview diffs
- Context hierarchy explorer (DIRECTION, STANDARDS, POLICIES, ARCHITECTURE)

### 7. Experiments (`/experiments`)
Keep as-is. A/B experiment tracking with variant session counts.

### 8. Tab Selector
Not a full page — gear icon in nav bar opens a dropdown/modal.
- Checkboxes for each view (Command Center, Tasks, Approvals, Org, Comms, Config, Experiments)
- Persisted to localStorage key `clawforce-visible-tabs`
- Default: all visible
- Gear icon always accessible regardless of selection

## Views to Remove (9)

| View | Route | Reason |
|------|-------|--------|
| Analytics | `/analytics` | Merged into Command Center |
| Sessions | `/sessions` | Merged into Command Center |
| Streams | `/streams` | Duplicate of Tasks, renders blank |
| Knowledge | `/knowledge` | Admin tool, use CLI |
| Tool Calls | `/tool-calls` | Use `cf flows` / `cf replay` |
| Audit History | `/audit` | Use CLI |
| Ops | `/ops` | Implementation details, use CLI |
| Goals | `/goals` | Not governance, use CLI |
| Initiative Detail | `/initiatives/:id` | Goes with Goals |

## Fixes Required

### Tasks Kanban Overflow
- CSS issue: horizontal scroll not working, BLOCKED/DONE columns off-screen
- Fix: ensure board container has `overflow-x: auto` and columns don't exceed viewport

### Approvals Loading
- Data structure mismatch between API response and component expectations
- Debug: compare `/approvals` response shape with what ApprovalQueue component expects
- Fix: align data transformation or adjust component

### Org Chart Missing Agents
- Only engineering team renders, dash-* agents missing
- Debug: check `/org` endpoint response — does it include all domain agents?
- Fix: ensure org tree construction includes all agents from domain config

### Command Center Consolidation
- Add tabbed sections for Budget Chart, Agent Performance, Sessions
- Budget chart: needs `/costs` endpoint to return time-series (date → amount), not just totals
- Sessions table: add `?limit=50&offset=0` pagination to `/sessions` endpoint
- Queue display: fix "max concurrency 0" — wire to actual config value

## Implementation Notes

- Remove view files: delete component files + remove routes from App.tsx + remove NavBar entries
- NavBar: filter visible tabs through localStorage preference
- Tab selector: small component — list of checkboxes, save to localStorage, NavBar reads on render
- Command Center expansion: move chart components from Analytics into Command Center with tab UI
- Backend fixes: may need changes in clawforce repo (adapters/openclaw.ts) for endpoint fixes
