---
name: dashboard-review
description: Autonomously navigate and QA the Clawforce dashboard using Playwright. Screenshots each view, checks for visual bugs, broken interactions, empty states, and console errors. Fix and re-verify.
---

# Dashboard Review Skill

Autonomously QA the Clawforce dashboard by navigating every view, screenshotting, testing interactions, and fixing issues.

## Prerequisites

- Dashboard must be running (OpenClaw gateway started, or `cd dashboard && npm run dev`)
- Playwright MCP must be available

## Process

### 1. Launch the dashboard

```
Navigate to the dashboard URL (default: http://localhost:PORT/clawforce/)
```

If the page doesn't load, check:
- Is the OpenClaw gateway running? (`openclaw gateway start`)
- Is the dashboard built? (`cd dashboard && npm run build`)
- Try the dev server: `cd dashboard && npm run dev` (runs on port 5173 with proxy)

### 2. Navigate each view and screenshot

Go through each view in order. For each:
1. Navigate to the route
2. Wait for data to load (check for loading spinners to disappear)
3. Take a screenshot
4. Check browser console for errors
5. Verify the view renders correctly (not blank, no broken layout)

**Views to check:**

| Route | View | What to verify |
|-------|------|---------------|
| `/clawforce/` | Command Center | 4 metric cards visible, initiative cards, activity feed, agent roster |
| `/clawforce/tasks` | Task Board | Kanban columns visible, task cards render, filter bar works |
| `/clawforce/approvals` | Approval Queue | Tabs visible (Pending/Approved/Rejected), rows render |
| `/clawforce/org` | Org Chart | Tree renders, agent nodes visible, connector lines |
| `/clawforce/analytics` | Analytics | Charts render (bar, donut), performance table, trust bars |
| `/clawforce/comms` | Comms Center | Thread list sidebar, message area |
| `/clawforce/config` | Config Editor | Tab list visible, agent list loads, form fields render |
| `/clawforce/initiatives/:id` | Initiative View | Stats row, chart, task list |

### 3. Test key interactions

For each interaction, perform the action and verify the result:

**Task Board:**
- [ ] Click a task card → detail panel opens
- [ ] Click filter pills → cards filter correctly
- [ ] Drag a task card to a different column → state updates

**Approval Queue:**
- [ ] Click a row → expands to show full context
- [ ] Click ✓ approve → row updates/disappears from pending
- [ ] Switch tabs (Pending → Approved) → different items shown

**Org Chart:**
- [ ] Click an agent node → detail panel slides in
- [ ] Detail panel shows stats and action buttons
- [ ] Click "Disable" button → agent status changes

**Config Editor:**
- [ ] Switch between tabs → different editor loads
- [ ] Edit a field → "unsaved changes" indicator appears
- [ ] Briefing builder → drag a chip from Available to Active

**Comms Center:**
- [ ] Click a thread → messages load in right panel
- [ ] Type a message → sends on Enter

**Assistant Widget:**
- [ ] Click floating button → chat panel opens
- [ ] Type a message → sends
- [ ] Click again → panel closes

### 4. Check for common issues

- [ ] Dark theme consistent across all views (no white flashes, no unstyled elements)
- [ ] Domain switcher works (if multiple domains configured)
- [ ] Navigation between views is smooth (no full page reloads)
- [ ] Loading states shown during data fetch (spinner, skeleton)
- [ ] Empty states handled (what shows when there are no tasks? no approvals?)
- [ ] Responsive: resize browser to smaller width — does layout break?
- [ ] Console errors: any React warnings, failed API calls, TypeScript runtime errors?

### 5. Fix and re-verify

For each issue found:
1. Identify the source file
2. Fix the issue
3. Rebuild: `cd dashboard && npm run build`
4. Refresh and verify the fix
5. Check that the fix didn't break other views

### 6. Report

After completing the review, summarize:
- Views checked (8/8)
- Interactions tested
- Issues found and fixed
- Remaining issues (if any)
- Screenshots of final state (all views)

## Notes

- The dashboard requires backend data to render meaningfully. If views show "No data" or empty states, that's expected in a fresh installation — verify the empty state looks correct.
- SSE real-time updates can be tested by triggering an action in one tab and watching for updates in another.
- The assistant widget requires an active OpenClaw session to respond — if it doesn't respond, that's an integration issue, not a dashboard bug.
