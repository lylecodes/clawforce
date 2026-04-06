# ClawForce Release Checklist

Pre-release gate for evaluating production readiness.

---

## Core Governance

- [ ] Budget enforcement blocks dispatch on breach (hourly, daily, monthly)
- [ ] Emergency stop blocks all agent tool calls
- [ ] Trust scoring and earned autonomy thresholds are applied correctly
- [ ] Approval queue holds high-risk actions until resolved
- [ ] Sweep handles stale tasks, deadlines, and budget resets

## Config

- [ ] No known lossy config sections (structured editor does not silently drop fields)
- [ ] Config versions are written on every save
- [ ] Config validation rejects invalid YAML with actionable error messages
- [ ] CLI config commands (`cf config set`, `cf config get`) cover all key fields
- [ ] Context file writes enforce ownership rules (DIRECTION/POLICIES — human only)

## Dashboard

- [ ] All core features are dashboard-accessible without requiring CLI fallback
- [ ] Domain selector switches all views correctly
- [ ] Monitor view shows current state (not stale cache)
- [ ] Tasks kanban reflects live database state
- [ ] Approvals queue loads pending proposals and accepts approve/reject actions
- [ ] Org view shows correct hierarchy and runtime status
- [ ] Comms view sends messages and shows thread history
- [ ] Config view saves changes and creates a version entry
- [ ] Context file editor reads and writes all four file types
- [ ] SSE stream delivers live updates without disconnecting on inactivity

## Locks and Controls

- [ ] Lock/override system is functional — locked fields cannot be changed by agents
- [ ] Role-based config access is enforced (agents cannot escalate privileges)
- [ ] Kill switch (emergency stop) activates and deactivates correctly
- [ ] Disable/enable works at domain and agent level
- [ ] Audit log entries are written for all mutating actions

## Shell and SDK

- [ ] Shell exposes full core governance surface (budget, trust, tasks, approvals, events, messages)
- [ ] SDK public API (`Clawforce.init()`, `cf.tasks`, `cf.budget`, `cf.events`, etc.) works without OpenClaw
- [ ] Adapters load correctly when OpenClaw is present

## Multi-Domain

- [ ] Multiple domains run in the same process without state leakage
- [ ] Domain selector in dashboard loads correct data per domain
- [ ] Budget limits are isolated per domain
- [ ] Kill switch affects only the targeted domain

## Extensions

- [ ] Extension registration validates contribution schema
- [ ] `GET /clawforce/api/extensions` returns registered extensions
- [ ] Unregister function removes the extension from the registry
- [ ] Extension API is exported at `clawforce/dashboard/extensions`

## Tests

- [ ] Full test suite passes (`npx vitest --run`)
- [ ] Backend critical flows have automated tests (budget enforcement, task state machine, approval flow, trust scoring, kill switch)
- [ ] Extension registration and validation have test coverage
- [ ] Auth module (bearer token, localhost-only, CORS) has test coverage
- [ ] Dashboard server tests cover standalone start/stop and API routing

## Documentation

- [ ] Deployment docs (`DEPLOYMENT_GUIDE.md`) match actual server behavior
- [ ] Operator guide (`OPERATOR_GUIDE.md`) matches actual dashboard views and actions
- [ ] Extension guide (`EXTENSION_GUIDE.md`) matches actual extension API
- [ ] CLAUDE.md Dashboard section reflects current view names and test counts
- [ ] CLI reference (`CLI.md`) covers all commands that appear in `cf --help`
- [ ] Config reference (`CONFIG_REFERENCE.md`) covers all schema fields

## Security

- [ ] Standalone server refuses to bind on non-localhost without a token
- [ ] Bearer token auth rejects requests missing or mismatched tokens
- [ ] CORS is restricted to configured origins (not wildcard)
- [ ] Path traversal blocked for static file serving
- [ ] Rate limiting active on API endpoints
- [ ] Security headers set on all responses

## Known Gaps (open before shipping)

Track any items that are partially implemented or deferred:

- [ ] _List any known gaps here_
