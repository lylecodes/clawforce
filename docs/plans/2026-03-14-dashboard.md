# Clawforce Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full-featured React SPA control plane for managing AI workforces, served from the OpenClaw gateway at `/clawforce`. Covers: Command Center, Task Board, Approval Queue, Org Chart, Analytics, Comms Center, and Config Editor. Real-time via SSE, actions via REST, dark theme.

**Architecture:** Backend routes registered via `api.registerHttpRoute()` (or `registerHttpHandler` fallback). React SPA built with Vite to `dashboard/dist/`, served as static files. SSE for live updates. All REST endpoints domain-scoped at `/clawforce/api/:domain/...`.

**Tech Stack:** TypeScript, React 18, Vite, dnd-kit, recharts, node:http (IncomingMessage/ServerResponse), vitest

**Reference:** Design spec at `docs/plans/2026-03-14-dashboard-design.md`

---

## Phase 1: Infrastructure (API + Serving)

Backend-only. Node/TypeScript. No React yet. This phase produces a working API that can be tested with curl.

### Task 1.0: Spike — Verify registerHttpRoute / registerHttpHandler

**Goal:** Confirm the gateway HTTP route registration API works for our use case. The `registerHttpRoute` API does exact path matching only (`entry.path === url.pathname`), so we likely need `registerHttpHandler` instead for prefix matching on `/clawforce/*`.

**Files:**
- Modify: `adapters/openclaw.ts`

- [ ] **Step 1: Read the plugin SDK types**

Examine `openclaw/plugin-sdk` types for `registerHttpRoute` and `registerHttpHandler`. Key findings from codebase analysis:

- `registerHttpRoute({ path, handler })` — registers an exact-match path. Handler signature: `(req: IncomingMessage, res: ServerResponse) => Promise<void> | void`
- `registerHttpHandler(handler)` — registers a catch-all handler. Handler signature: `(req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean`. Return `true` if handled.
- Gateway matching: `httpRoutes` checked first (exact match), then `httpHandlers` (catch-all, first-wins)
- **Conclusion:** We need `registerHttpHandler` because we have dynamic paths (`/clawforce/api/:domain/tasks`, `/clawforce/assets/main.js`, etc.)

- [ ] **Step 2: Register a trivial test handler**

In `adapters/openclaw.ts`, add a temporary test registration near the existing service/command registrations:

```typescript
api.registerHttpHandler(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/clawforce")) return false;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: url.pathname }));
  return true;
});
```

- [ ] **Step 3: Test manually**

Start OpenClaw gateway, hit `http://localhost:<port>/clawforce/test`. Verify JSON response. Then remove the test handler.

- [ ] **Step 4: Document the result**

If successful: proceed with `registerHttpHandler` approach.
If failed: fall back to standalone server approach (keep existing `server.ts`, add SSE + action endpoints to it, serve on port 3117).

**Decision gate:** All subsequent tasks assume `registerHttpHandler` works. If it doesn't, the same route handler code applies but gets wired into the existing `server.ts` HTTP server instead.

---

### Task 1.1: SSE Infrastructure

**Goal:** Server-Sent Events endpoint at `/clawforce/api/sse?domain=<id>`. Manages connected clients, pushes typed events.

**Files:**
- Create: `src/dashboard/sse.ts`
- Test: `test/dashboard/sse.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dashboard/sse.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SSEManager, SSEEventType } from "../../src/dashboard/sse.js";

describe("SSEManager", () => {
  let manager: SSEManager;

  beforeEach(() => {
    manager = new SSEManager();
  });

  it("tracks connected clients by domain", () => {
    const mockRes = createMockResponse();
    manager.addClient("test-domain", mockRes);
    expect(manager.clientCount("test-domain")).toBe(1);
  });

  it("removes client on close", () => {
    const mockRes = createMockResponse();
    manager.addClient("test-domain", mockRes);
    // Simulate close
    mockRes.emit("close");
    expect(manager.clientCount("test-domain")).toBe(0);
  });

  it("broadcasts typed events to domain clients", () => {
    const mockRes = createMockResponse();
    manager.addClient("test-domain", mockRes);
    manager.broadcast("test-domain", "budget:update", { spent: 100 });
    expect(mockRes.writtenData).toContain("event: budget:update");
    expect(mockRes.writtenData).toContain('"spent":100');
  });

  it("does not send to clients on different domains", () => {
    const mockRes = createMockResponse();
    manager.addClient("other-domain", mockRes);
    manager.broadcast("test-domain", "task:update", {});
    expect(mockRes.writtenData).toBe("");
  });
});

function createMockResponse() {
  const res = {
    writtenData: "",
    writeHead: vi.fn(),
    write: vi.fn((data: string) => { res.writtenData += data; return true; }),
    end: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    headersSent: false,
    _closeHandlers: [] as Function[],
  };
  res.on.mockImplementation((event: string, handler: Function) => {
    if (event === "close") res._closeHandlers.push(handler);
    return res;
  });
  res.emit.mockImplementation((event: string) => {
    if (event === "close") res._closeHandlers.forEach((h) => h());
  });
  return res;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard/sse.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SSEManager**

Create `src/dashboard/sse.ts`:

```typescript
import type { ServerResponse } from "node:http";

export type SSEEventType =
  | "budget:update"
  | "task:update"
  | "agent:status"
  | "approval:new"
  | "approval:resolved"
  | "message:new"
  | "plan:update"
  | "escalation:new"
  | "meeting:started"
  | "meeting:turn"
  | "meeting:ended"
  | "config:changed";

type Client = {
  id: string;
  domain: string;
  res: ServerResponse;
};

export class SSEManager {
  private clients = new Map<string, Client[]>();
  private nextId = 0;

  addClient(domain: string, res: ServerResponse): string {
    const id = String(++this.nextId);
    const client: Client = { id, domain, res };

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId: id })}\n\n`);

    // Track
    const clients = this.clients.get(domain) ?? [];
    clients.push(client);
    this.clients.set(domain, clients);

    // Clean up on close
    res.on("close", () => this.removeClient(domain, id));

    return id;
  }

  removeClient(domain: string, clientId: string): void {
    const clients = this.clients.get(domain);
    if (!clients) return;
    const filtered = clients.filter((c) => c.id !== clientId);
    if (filtered.length === 0) {
      this.clients.delete(domain);
    } else {
      this.clients.set(domain, filtered);
    }
  }

  broadcast(domain: string, event: SSEEventType, data: unknown): void {
    const clients = this.clients.get(domain);
    if (!clients) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(payload);
      } catch {
        this.removeClient(domain, client.id);
      }
    }
  }

  clientCount(domain: string): number {
    return this.clients.get(domain)?.length ?? 0;
  }
}

// Singleton instance
let _sseManager: SSEManager | null = null;

export function getSSEManager(): SSEManager {
  if (!_sseManager) _sseManager = new SSEManager();
  return _sseManager;
}

export function emitSSE(domain: string, event: SSEEventType, data: unknown): void {
  _sseManager?.broadcast(domain, event, data);
}
```

- [ ] **Step 4: Run tests, verify passing**

Run: `npx vitest run test/dashboard/sse.test.ts`

---

### Task 1.2: Action Endpoints

**Goal:** REST handlers for approve, reject, reassign, create task, disable/enable agent, kill session, message agent, save/validate config, budget allocate, meeting create/message/end.

**Files:**
- Create: `src/dashboard/actions.ts`
- Test: `test/dashboard/actions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dashboard/actions.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleAction } from "../../src/dashboard/actions.js";

// Mock core functions
vi.mock("../../src/approval/resolve.js");
vi.mock("../../src/tasks/ops.js");
vi.mock("../../src/enforcement/disabled-store.js");

describe("handleAction", () => {
  it("approves a proposal", () => {
    const { approveProposal } = require("../../src/approval/resolve.js");
    approveProposal.mockReturnValue({ id: "p1", status: "approved" });

    const result = handleAction("test-project", "approvals/p1/approve", {});
    expect(result.status).toBe(200);
    expect(approveProposal).toHaveBeenCalledWith("test-project", "p1", undefined);
  });

  it("rejects a proposal with feedback", () => {
    const { rejectProposal } = require("../../src/approval/resolve.js");
    rejectProposal.mockReturnValue({ id: "p1", status: "rejected" });

    const result = handleAction("test-project", "approvals/p1/reject", { feedback: "nope" });
    expect(result.status).toBe(200);
    expect(rejectProposal).toHaveBeenCalledWith("test-project", "p1", "nope");
  });

  it("reassigns a task", () => {
    const { reassignTask } = require("../../src/tasks/ops.js");
    reassignTask.mockReturnValue(true);

    const result = handleAction("test-project", "tasks/t1/reassign", { newAssignee: "agent-b" });
    expect(result.status).toBe(200);
  });

  it("disables an agent", () => {
    const { disableAgent } = require("../../src/enforcement/disabled-store.js");

    const result = handleAction("test-project", "agents/a1/disable", { reason: "testing" });
    expect(result.status).toBe(200);
    expect(disableAgent).toHaveBeenCalledWith("test-project", "a1", "testing");
  });

  it("returns 404 for unknown action", () => {
    const result = handleAction("test-project", "unknown/action", {});
    expect(result.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard/actions.test.ts`

- [ ] **Step 3: Implement action handlers**

Create `src/dashboard/actions.ts`. Each action is a thin wrapper around an existing core function:

```typescript
import type { RouteResult } from "./routes.js";
import { approveProposal, rejectProposal } from "../approval/resolve.js";
import { createTask, reassignTask, transitionTask } from "../tasks/ops.js";
import { disableAgent, enableAgent } from "../enforcement/disabled-store.js";
import { emitSSE } from "./sse.js";

/**
 * Route a POST action request. `actionPath` is the path after `/clawforce/api/:domain/`.
 * e.g., "approvals/p1/approve", "tasks/t1/reassign"
 */
export function handleAction(
  projectId: string,
  actionPath: string,
  body: Record<string, unknown>,
): RouteResult {
  const segments = actionPath.split("/").filter(Boolean);
  // ... pattern match segments to core function calls
}
```

Implement handlers for these action patterns:
- `approvals/:id/approve` -> `approveProposal()` + emit `approval:resolved`
- `approvals/:id/reject` -> `rejectProposal()` + emit `approval:resolved`
- `tasks/:id/reassign` -> `reassignTask()` + emit `task:update`
- `tasks/create` -> `createTask()` + emit `task:update`
- `agents/:id/disable` -> `disableAgent()` + emit `agent:status`
- `agents/:id/enable` -> `enableAgent()` + emit `agent:status`
- `agents/:id/kill` -> kill via `api.runtime` (needs adapter wiring, deferred to gateway-routes)
- `agents/:id/message` -> `injectAgentMessage()` (needs adapter wiring, deferred to gateway-routes)
- `config/save` -> write config (needs config writer wiring)
- `config/validate` -> validate config
- `config/preview` -> compute `ConfigChangePreview`
- `budget/allocate` -> update budget allocation
- `meetings/create` -> `startMeeting()` + emit `meeting:started`
- `meetings/:id/message` -> `sendChannelMessage()` + emit `meeting:turn`
- `meetings/:id/end` -> `concludeMeeting()` + emit `meeting:ended`

Each handler emits SSE events after successful mutation.

- [ ] **Step 4: Run tests, verify passing**

Run: `npx vitest run test/dashboard/actions.test.ts`

---

### Task 1.3: Extended Read Endpoints

**Goal:** Add query functions that the design spec requires but don't exist in `queries.ts` yet. The existing queries cover agents, tasks, sessions, events, metrics, costs, org, health, messages, goals. New ones needed: dashboard summary, approvals, budget status, budget forecast, trust scores, config read.

**Files:**
- Modify: `src/dashboard/queries.ts`
- Test: `test/dashboard/queries.test.ts` (new or extend existing)

- [ ] **Step 1: Write the failing test**

Create `test/dashboard/queries-extended.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("../../src/approval/resolve.js");
vi.mock("../../src/budget-windows.js");
vi.mock("../../src/budget/forecast.js");
vi.mock("../../src/trust/tracker.js");

import {
  queryDashboardSummary,
  queryApprovals,
  queryBudgetStatus,
  queryBudgetForecast,
  queryTrustScores,
  queryConfig,
} from "../../src/dashboard/queries.js";

describe("extended queries", () => {
  it("queryDashboardSummary returns metric card data", () => {
    // Setup mocks for budget, agent counts, task counts, approval counts
    const result = queryDashboardSummary("test-project");
    expect(result).toHaveProperty("budgetUtilization");
    expect(result).toHaveProperty("activeAgents");
    expect(result).toHaveProperty("tasksInFlight");
    expect(result).toHaveProperty("pendingApprovals");
  });

  it("queryApprovals returns filtered proposals", () => {
    const { listPendingProposals } = require("../../src/approval/resolve.js");
    listPendingProposals.mockReturnValue([]);
    const result = queryApprovals("test-project", {});
    expect(result).toHaveProperty("proposals");
  });

  it("queryTrustScores returns per-agent category scores", () => {
    const result = queryTrustScores("test-project");
    expect(result).toHaveProperty("agents");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard/queries-extended.test.ts`

- [ ] **Step 3: Implement extended queries**

Add to `src/dashboard/queries.ts`:

- `queryDashboardSummary(projectId)` — aggregates budget utilization (from `getBudgetStatus`), active agent count (from `queryAgents`), tasks in flight (from `listTasks` with open/in_progress states), pending approval count (from `listPendingProposals`). Returns 4 metric card values.

- `queryApprovals(projectId, filters)` — wraps `listPendingProposals` plus `getDb` query for approved/rejected proposals. Supports status filter (pending/approved/rejected).

- `queryBudgetStatus(projectId)` — wraps `getBudgetStatus` from `budget-windows.ts`. Returns counters + limits + utilization percentages.

- `queryBudgetForecast(projectId)` — wraps `computeDailySnapshot`, `computeWeeklyTrend`, `computeMonthlyProjection` from `budget/forecast.ts`.

- `queryTrustScores(projectId)` — wraps `getAllCategoryStats` and `getActiveTrustOverrides` from `trust/tracker.ts`. Grouped by agent.

- `queryConfig(projectId)` — reads the current config via `getExtendedProjectConfig` and domain config. Returns structured config sections (agents, budget, tool_gates, initiatives, jobs, safety).

- `queryMeetings(projectId)` — queries channels with `type = 'meeting'` from `channels/store.ts`.

- `queryMeetingDetail(projectId, meetingId)` — wraps `getChannel` + `buildChannelTranscript`.

- [ ] **Step 4: Update barrel export**

Add new query functions to `src/dashboard/index.ts`.

- [ ] **Step 5: Run tests, verify passing**

Run: `npx vitest run test/dashboard/queries-extended.test.ts`

---

### Task 1.4: Gateway Route Handler

**Goal:** Single HTTP handler registered via `api.registerHttpHandler()` that routes all `/clawforce/*` requests to the appropriate handler (SSE, REST reads, REST actions, static files).

**Files:**
- Create: `src/dashboard/gateway-routes.ts`
- Test: `test/dashboard/gateway-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dashboard/gateway-routes.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/dashboard/queries.js");
vi.mock("../../src/dashboard/actions.js");
vi.mock("../../src/dashboard/sse.js");

import { createDashboardHandler } from "../../src/dashboard/gateway-routes.js";

describe("createDashboardHandler", () => {
  it("returns false for non-clawforce paths", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/some/other/path");
    const handled = await handler(req, res);
    expect(handled).toBe(false);
  });

  it("routes /clawforce/api/:domain/agents to read handler", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/test-project/agents");
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res.statusCode).not.toBe(404);
  });

  it("routes POST /clawforce/api/:domain/approvals/:id/approve to action handler", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("POST", "/clawforce/api/test-project/approvals/p1/approve");
    const handled = await handler(req, res);
    expect(handled).toBe(true);
  });

  it("routes /clawforce/api/sse to SSE handler", async () => {
    const handler = createDashboardHandler({});
    const { req, res } = createMockRequest("GET", "/clawforce/api/sse?domain=test-project");
    const handled = await handler(req, res);
    expect(handled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dashboard/gateway-routes.test.ts`

- [ ] **Step 3: Implement gateway route handler**

Create `src/dashboard/gateway-routes.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "./routes.js";
import { handleAction } from "./actions.js";
import { getSSEManager } from "./sse.js";

export type DashboardHandlerOptions = {
  /** Absolute path to dashboard/dist/ for static files */
  staticDir?: string;
  /** Function to inject a message into an agent session */
  injectAgentMessage?: (params: { sessionKey: string; message: string }) => Promise<{ runId?: string }>;
};

export function createDashboardHandler(options: DashboardHandlerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/clawforce")) return false;

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }

    // SSE endpoint: /clawforce/api/sse?domain=<id>
    if (url.pathname === "/clawforce/api/sse" && req.method === "GET") {
      const domain = url.searchParams.get("domain");
      if (!domain) { respondJson(res, 400, { error: "domain required" }); return true; }
      getSSEManager().addClient(domain, res);
      return true;
    }

    // API routes: /clawforce/api/:domain/...
    if (url.pathname.startsWith("/clawforce/api/")) {
      const apiPath = url.pathname.slice("/clawforce/api/".length);
      const slashIdx = apiPath.indexOf("/");
      const domain = slashIdx === -1 ? apiPath : apiPath.slice(0, slashIdx);
      const resource = slashIdx === -1 ? "" : apiPath.slice(slashIdx + 1);

      if (req.method === "POST") {
        const body = await parseBody(req);
        const result = handleAction(domain, resource, body);
        respondJson(res, result.status, result.body);
        return true;
      }

      // GET — map to existing handleRequest (rewrite path to /api/projects/:domain/...)
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) params[k] = v;

      // Map new endpoint paths to existing query functions
      const result = routeRead(domain, resource, params);
      respondJson(res, result.status, result.body);
      return true;
    }

    // Static files: /clawforce/* -> serve from dashboard/dist/
    if (options.staticDir) {
      return serveStatic(url.pathname, options.staticDir, res);
    }

    // SPA fallback
    respondJson(res, 404, { error: "Not found" });
    return true;
  };
}
```

The `routeRead()` function maps the new dashboard endpoint paths to existing + new query functions:
- `/dashboard` -> `queryDashboardSummary()`
- `/agents` -> `queryAgents()`
- `/agents/:id` -> `queryAgentDetail()`
- `/tasks` -> `queryTasks()`
- `/tasks/:id` -> `queryTaskDetail()`
- `/approvals` -> `queryApprovals()`
- `/messages` -> `queryMessages()`
- `/meetings` -> `queryMeetings()`
- `/meetings/:id` -> `queryMeetingDetail()`
- `/budget` -> `queryBudgetStatus()`
- `/budget/forecast` -> `queryBudgetForecast()`
- `/trust` -> `queryTrustScores()`
- `/costs` -> `queryCosts()`
- `/goals` -> `queryGoals()`
- `/config` -> `queryConfig()`
- `/org` -> `queryOrgChart()`

The `serveStatic()` function serves files from `dashboard/dist/` with correct MIME types, and falls back to `index.html` for SPA client-side routing.

- [ ] **Step 4: Run tests, verify passing**

Run: `npx vitest run test/dashboard/gateway-routes.test.ts`

---

### Task 1.5: Wire into OpenClaw Adapter

**Goal:** Register the dashboard HTTP handler in the OpenClaw plugin adapter. Wire SSE emission into existing lifecycle hooks.

**Files:**
- Modify: `adapters/openclaw.ts`
- Modify: `src/dashboard/index.ts` (update barrel exports)

- [ ] **Step 1: Register HTTP handler**

In `adapters/openclaw.ts`, after the existing `registerCommand` calls (around line 1457), add:

```typescript
// --- Dashboard HTTP handler ---
import { createDashboardHandler } from "../src/dashboard/gateway-routes.js";
import { emitSSE } from "../src/dashboard/sse.js";

const dashboardHandler = createDashboardHandler({
  staticDir: path.resolve(import.meta.dirname, "../dashboard/dist"),
  injectAgentMessage: (params) => api.injectAgentMessage(params),
});

api.registerHttpHandler(async (req, res) => {
  return dashboardHandler(req, res);
});
```

- [ ] **Step 2: Wire SSE emission into lifecycle hooks**

Add SSE emission calls at existing hook points. In the `after_tool_call` hook handler, add:

```typescript
// After cost recording
emitSSE(projectId, "budget:update", { projectId, agentId, /* cost data */ });
```

In the task state transition code path, add:
```typescript
emitSSE(projectId, "task:update", { taskId, newState, agentId });
```

In the `agent_end` hook handler:
```typescript
emitSSE(projectId, "agent:status", { agentId, status: "idle" });
```

In the approval creation code path:
```typescript
emitSSE(projectId, "approval:new", { proposalId, title, riskTier });
```

In approval resolution (already called from actions.ts, but also from Telegram callback):
```typescript
emitSSE(projectId, "approval:resolved", { proposalId, status });
```

- [ ] **Step 3: Update barrel exports**

Update `src/dashboard/index.ts` to export new modules:

```typescript
export { SSEManager, getSSEManager, emitSSE } from "./sse.js";
export type { SSEEventType } from "./sse.js";
export { handleAction } from "./actions.js";
export { createDashboardHandler } from "./gateway-routes.js";
export type { DashboardHandlerOptions } from "./gateway-routes.js";
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Test the full flow**

Start OpenClaw with the clawforce plugin. Verify:
1. `GET /clawforce/api/test-domain/agents` returns JSON
2. `GET /clawforce/api/sse?domain=test-domain` opens SSE connection
3. `POST /clawforce/api/test-domain/approvals/p1/approve` returns result
4. `GET /clawforce` returns 404 (no static files yet — that's Phase 2)

---

## Phase 2: React Scaffold + Command Center

Frontend phase. Sets up the entire React project and builds the first (most useful) view.

### Task 2.1: Vite + React Project Setup

**Goal:** Create `dashboard/` directory with Vite, React 18, TypeScript, and the dark theme CSS tokens. Build produces `dashboard/dist/`.

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/tsconfig.json`
- Create: `dashboard/vite.config.ts`
- Create: `dashboard/index.html`
- Create: `dashboard/src/main.tsx`
- Create: `dashboard/src/App.tsx`
- Create: `dashboard/src/styles/theme.ts`
- Create: `dashboard/src/styles/global.css`

- [ ] **Step 1: Initialize project**

```bash
mkdir -p dashboard/src/styles dashboard/src/api dashboard/src/hooks dashboard/src/views dashboard/src/components dashboard/public
```

Create `dashboard/package.json`:
```json
{
  "name": "clawforce-dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd dashboard
npm install react@18 react-dom@18 react-router-dom@6
npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom
```

- [ ] **Step 3: Configure Vite**

Create `dashboard/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/clawforce/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/clawforce/api": "http://localhost:3000",
    },
  },
});
```

`base: "/clawforce/"` is critical — all asset paths will be prefixed with `/clawforce/`.

- [ ] **Step 4: Create TypeScript config**

Create `dashboard/tsconfig.json` with strict mode, JSX react-jsx, target ESNext.

- [ ] **Step 5: Create index.html**

Create `dashboard/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Clawforce</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 6: Create dark theme tokens**

Create `dashboard/src/styles/theme.ts`:

```typescript
export const theme = {
  colors: {
    bg: {
      primary: "#0d1117",     // GitHub dark bg
      secondary: "#161b22",   // Card bg
      tertiary: "#21262d",    // Elevated surfaces
      hover: "#30363d",       // Hover state
    },
    border: {
      default: "#30363d",
      muted: "#21262d",
    },
    text: {
      primary: "#e6edf3",
      secondary: "#8b949e",
      muted: "#484f58",
    },
    accent: {
      blue: "#58a6ff",
      green: "#3fb950",
      orange: "#d29922",
      red: "#f85149",
      purple: "#bc8cff",
    },
    status: {
      active: "#3fb950",
      idle: "#8b949e",
      warning: "#d29922",
      disabled: "#f85149",
    },
    risk: {
      low: "#3fb950",
      medium: "#d29922",
      high: "#f85149",
    },
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 4, md: 6, lg: 8 },
  fontSize: { xs: "11px", sm: "12px", md: "14px", lg: "16px", xl: "20px", xxl: "24px" },
};
```

Create `dashboard/src/styles/global.css` with CSS reset and dark theme base styles.

- [ ] **Step 7: Create main entry point and App shell**

Create `dashboard/src/main.tsx` (renders App into root).

Create `dashboard/src/App.tsx` (placeholder with router, dark bg).

- [ ] **Step 8: Verify build**

```bash
cd dashboard && npm run build
```

Verify `dashboard/dist/` contains `index.html` and asset files.

- [ ] **Step 9: Verify static serving**

Start OpenClaw gateway. Navigate to `http://localhost:<port>/clawforce/`. Verify the React app loads.

---

### Task 2.2: API Client + SSE Hook

**Goal:** REST client wrapper and SSE connection manager for the React app.

**Files:**
- Create: `dashboard/src/api/client.ts`
- Create: `dashboard/src/api/sse.ts`
- Create: `dashboard/src/api/types.ts`
- Create: `dashboard/src/hooks/useSSE.ts`
- Create: `dashboard/src/hooks/useDomain.ts`

- [ ] **Step 1: Create API types**

Create `dashboard/src/api/types.ts`. Define TypeScript types for all API responses:

```typescript
export type DashboardSummary = {
  budgetUtilization: { spent: number; limit: number; pct: number; exhaustionEta?: string };
  activeAgents: number;
  tasksInFlight: number;
  pendingApprovals: number;
};

export type Agent = {
  id: string;
  extends?: string;
  title?: string;
  department?: string;
  team?: string;
  status: "active" | "idle" | "disabled";
  currentSessionKey?: string;
};

// ... types for Task, Proposal, Message, Meeting, BudgetStatus, TrustScore, etc.
```

- [ ] **Step 2: Create REST client**

Create `dashboard/src/api/client.ts`:

```typescript
const BASE = "/clawforce/api";

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  getDashboard: (domain: string) => fetchJson<DashboardSummary>(`/${domain}/dashboard`),
  getAgents: (domain: string) => fetchJson<Agent[]>(`/${domain}/agents`),
  getTasks: (domain: string, params?: Record<string, string>) => /* ... */,
  getApprovals: (domain: string, params?: Record<string, string>) => /* ... */,
  approve: (domain: string, id: string) => postJson(`/${domain}/approvals/${id}/approve`, {}),
  reject: (domain: string, id: string, feedback?: string) => postJson(`/${domain}/approvals/${id}/reject`, { feedback }),
  // ... all other endpoints
};
```

- [ ] **Step 3: Create SSE connection manager**

Create `dashboard/src/api/sse.ts`:

```typescript
export type SSEEventHandler = (event: string, data: unknown) => void;

export function connectSSE(domain: string, onEvent: SSEEventHandler): () => void {
  const es = new EventSource(`/clawforce/api/sse?domain=${encodeURIComponent(domain)}`);

  const eventTypes = [
    "budget:update", "task:update", "agent:status",
    "approval:new", "approval:resolved", "message:new",
    "plan:update", "escalation:new", "meeting:started",
    "meeting:turn", "meeting:ended", "config:changed",
  ];

  for (const type of eventTypes) {
    es.addEventListener(type, (e) => {
      try { onEvent(type, JSON.parse(e.data)); } catch {}
    });
  }

  // Return cleanup function
  return () => es.close();
}
```

- [ ] **Step 4: Create useSSE hook**

Create `dashboard/src/hooks/useSSE.ts`:

```typescript
import { useEffect, useRef, useCallback } from "react";
import { connectSSE } from "../api/sse";

export function useSSE(domain: string | null, onEvent: (event: string, data: unknown) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!domain) return;
    const cleanup = connectSSE(domain, (event, data) => onEventRef.current(event, data));
    return cleanup;
  }, [domain]);
}
```

- [ ] **Step 5: Create useDomain hook**

Create `dashboard/src/hooks/useDomain.ts` — React context for the active domain. Fetches the project list on mount, allows switching. Persists selection to localStorage.

---

### Task 2.3: Layout Shell

**Goal:** NavBar, DomainSwitcher, and router that provides the navigation frame for all views.

**Files:**
- Modify: `dashboard/src/App.tsx`
- Create: `dashboard/src/components/NavBar.tsx`
- Create: `dashboard/src/components/DomainSwitcher.tsx`

- [ ] **Step 1: Create NavBar component**

Horizontal navigation bar with tabs: Command Center, Task Board, Approvals, Org Chart, Comms, Config, Analytics. Active tab highlighted. Clawforce logo/text on left.

- [ ] **Step 2: Create DomainSwitcher component**

Pill buttons for each domain. "All Domains" aggregate option. Active domain highlighted with accent color. Placed in the top bar.

- [ ] **Step 3: Wire App.tsx with router**

Use `react-router-dom` with `BrowserRouter` (basename `/clawforce`):
- `/` -> CommandCenter
- `/tasks` -> TaskBoard
- `/approvals` -> ApprovalQueue
- `/org` -> OrgChart
- `/comms` -> CommsCenter
- `/config` -> ConfigEditor
- `/analytics` -> Analytics
- `/initiatives/:id` -> InitiativeView

Wrap everything in `DomainProvider` context.

- [ ] **Step 4: Build and verify**

Build, verify the shell loads with navigation and domain switching works.

---

### Task 2.4: Command Center View

**Goal:** The home view with 4 metric cards, initiative cards, activity feed, and agent roster.

**Files:**
- Create: `dashboard/src/views/CommandCenter.tsx`
- Create: `dashboard/src/components/MetricCard.tsx`
- Create: `dashboard/src/components/InitiativeCard.tsx`
- Create: `dashboard/src/components/ActivityFeed.tsx`
- Create: `dashboard/src/hooks/useBudget.ts`
- Create: `dashboard/src/hooks/useAgents.ts`

- [ ] **Step 1: Create MetricCard component**

Reusable card showing: label, large number, subtitle/trend, optional progress bar. Color-coded based on threshold (green/orange/red). Used for budget utilization, active agents, tasks in flight, pending approvals.

- [ ] **Step 2: Create InitiativeCard component**

Shows: initiative name, allocation %, spend progress bar (colored by utilization), task count breakdown (open/in-progress/done), active agent avatars. Click navigates to `/initiatives/:id`.

- [ ] **Step 3: Create ActivityFeed component**

Scrollable list of recent events. Each entry: timestamp, icon (by type), description text, agent name. Auto-scrolls on new SSE events. Types: cost record, task transition, approval, message, agent status change.

- [ ] **Step 4: Create data hooks**

Create `dashboard/src/hooks/useBudget.ts` — fetches budget data, subscribes to `budget:update` SSE events, updates state.

Create `dashboard/src/hooks/useAgents.ts` — fetches agent list, subscribes to `agent:status` SSE events.

- [ ] **Step 5: Create CommandCenter view**

Layout:
- Top: 4 MetricCards in a row (budget, agents, tasks, approvals)
- Middle: up to 3 InitiativeCards in a row
- Bottom: 2-column split — ActivityFeed (left 2/3), Agent roster (right 1/3)

Agent roster: compact list showing agent name, role badge, status dot (green/orange/grey/red), current task if any.

- [ ] **Step 6: Wire SSE for real-time updates**

Use `useSSE` hook in CommandCenter. On `budget:update`, `task:update`, `agent:status` events, refetch relevant data or optimistically update state.

- [ ] **Step 7: Build and test**

Build dashboard. Verify Command Center renders with mock/real data. Verify SSE updates show in real-time.

---

## Phase 3: Task Board + Approval Queue

### Task 3.1: Task Board (Kanban)

**Goal:** 5-column Kanban board with drag-to-reassign. Filter by initiative, agent, priority.

**Files:**
- Create: `dashboard/src/views/TaskBoard.tsx`
- Create: `dashboard/src/components/TaskCard.tsx`
- Create: `dashboard/src/hooks/useTasks.ts`

**Dependencies:** Install `@dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities` in `dashboard/`.

- [ ] **Step 1: Install dnd-kit**

```bash
cd dashboard && npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

- [ ] **Step 2: Create useTasks hook**

Fetches tasks for active domain. Supports filter params (state, assignee, priority, initiative). Subscribes to `task:update` SSE events. Groups tasks by state for Kanban columns.

- [ ] **Step 3: Create TaskCard component**

Compact card showing: title, priority badge (P0 red, P1 orange, P2 yellow, P3 grey), initiative color left border, assigned agent avatar/name, cost (if any). Draggable via dnd-kit.

- [ ] **Step 4: Create TaskBoard view**

Layout:
- Top: filter bar with initiative pills, agent dropdown, priority dropdown, "Create Task" button
- Main: 5 columns (Open, In Progress, Review, Blocked, Done-collapsed)
- Each column: header with count badge, scrollable list of TaskCards

Drag behavior:
- Drag between columns -> calls `POST .../tasks/:id/reassign` or state transition
- Drop on different agent -> calls `POST .../tasks/:id/reassign`
- Validation: prevent invalid state transitions (e.g., done -> open)

- [ ] **Step 5: Create task detail panel**

Click a TaskCard -> slide-in panel from right showing:
- Full task description
- Evidence list
- State transition history
- Linked goal
- Action buttons (Reassign, transition state)

- [ ] **Step 6: Create task modal**

"Create Task" button opens a modal form: title, assignee (dropdown), priority (dropdown), goal (dropdown). Submits to `POST .../tasks/create`.

- [ ] **Step 7: Build and test**

Verify drag-and-drop works. Verify task creation. Verify SSE updates move cards in real-time.

---

### Task 3.2: Approval Queue

**Goal:** Pending proposals with expand/collapse, approve/reject actions, trust context.

**Files:**
- Create: `dashboard/src/views/ApprovalQueue.tsx`
- Create: `dashboard/src/components/ApprovalRow.tsx`
- Create: `dashboard/src/components/ChangeRiskBadge.tsx`
- Create: `dashboard/src/hooks/useApprovals.ts`

- [ ] **Step 1: Create useApprovals hook**

Fetches approvals for active domain. Supports tab filter (pending/approved/rejected). Subscribes to `approval:new` and `approval:resolved` SSE events. Pending count for tab badge.

- [ ] **Step 2: Create ChangeRiskBadge component**

Small colored badge: LOW (green), MEDIUM (orange), HIGH (red). Used across approval rows and config editor.

- [ ] **Step 3: Create ApprovalRow component**

Two modes:
- **Collapsed** (default): single row — risk badge, title (truncated), agent name, category, timestamp, inline approve (checkmark) and reject (X) buttons
- **Expanded** (click to toggle): full context panel below the row — tool name, category, task context, initiative, action preview text, larger approve/reject buttons with optional feedback input, trust context bar

Trust context bar: shows "X% approval rate for [category] by [agent]". If above threshold, shows "Enable auto-approve" link.

- [ ] **Step 4: Create ApprovalQueue view**

Layout:
- Top: tabs (Pending with count badge, Approved, Rejected), "Approve All Low Risk" button
- Main: list of ApprovalRows

Approve/reject calls the REST action endpoint. On success, row animates out (pending tab) or updates status. SSE `approval:new` adds new rows to the top.

- [ ] **Step 5: Build and test**

Verify inline approve/reject works. Verify expand/collapse. Verify SSE adds new approvals in real-time.

---

## Phase 4: Org Chart + Analytics

### Task 4.1: Org Chart

**Goal:** Tree visualization of agent hierarchy with status overlay and click-for-detail.

**Files:**
- Create: `dashboard/src/views/OrgChart.tsx`
- Create: `dashboard/src/components/AgentNode.tsx`
- Create: `dashboard/src/components/AgentDetailPanel.tsx`

- [ ] **Step 1: Create AgentNode component**

Tree node card showing: agent name, title, department/team label, status dot (active green, idle grey, warning orange, disabled red), trust score mini-bar, spend amount.

Manager nodes: blue left border, larger. Employee nodes: green left border.

- [ ] **Step 2: Create AgentDetailPanel component**

Slide-in panel from right:
- Stats grid: total cost, trust score, tasks completed, compliance %
- Current task (if active)
- Action buttons: Message, Reassign Tasks, Disable/Enable
- "Edit Config" link -> navigates to Config Editor for this agent

- [ ] **Step 3: Create OrgChart view**

Layout: top-down tree, centered. Root = the manager(s) with no `reports_to`. Children = agents who report to each parent.

Use CSS flexbox/grid for tree layout (no heavy D3 dependency). Lines connecting parent to children using SVG or CSS borders.

Interactions:
- Click agent -> opens AgentDetailPanel
- Double-click agent -> navigate to `/config` with agent pre-selected
- SSE `agent:status` updates status dots in real-time

- [ ] **Step 4: Future: drag-to-reparent**

Optional enhancement: drag agent node to new parent to change reporting chain. Calls `POST .../config/save` with updated `reports_to`. This can be deferred to Phase 5 Config Editor work.

- [ ] **Step 5: Build and test**

Verify tree renders correctly. Verify detail panel opens. Verify real-time status updates.

---

### Task 4.2: Analytics

**Goal:** Historical charts — cost trends, agent performance, trust evolution. Pure read, no mutations.

**Files:**
- Create: `dashboard/src/views/Analytics.tsx`
- Create: `dashboard/src/hooks/useAnalytics.ts`

**Dependencies:** Install `recharts` in `dashboard/`.

- [ ] **Step 1: Install recharts**

```bash
cd dashboard && npm install recharts
```

- [ ] **Step 2: Create useAnalytics hook**

Fetches: costs (daily aggregates), trust scores, task counts per agent, compliance rates. Accepts time range param (today, 7d, 30d, custom). Calls existing `/costs`, `/trust`, `/agents`, `/tasks` endpoints with appropriate date filters.

- [ ] **Step 3: Create Analytics view**

Layout:
- Top: time range selector (Today, 7 Days, 30 Days, Custom date range picker)
- 4-panel grid:
  - **Daily cost bar chart** (recharts BarChart): x = date, y = cents, bars colored by initiative. Week-over-week trend line overlay.
  - **Cost by initiative donut** (recharts PieChart): segments colored by initiative, legend on right.
  - **Agent performance table**: sortable columns — agent name, tasks completed, compliance %, total cost, $/task. Sort by clicking column header.
  - **Trust score bars**: horizontal bar per agent per category, with trend arrows (up/down/stable).

- [ ] **Step 4: Build and test**

Verify charts render with data. Verify time range selector filters data. Verify table sorting.

---

## Phase 5: Comms Center + Config Editor

### Task 5.1: Comms Center

**Goal:** Message threads, escalation log, live meeting mode with user participation.

**Files:**
- Create: `dashboard/src/views/CommsCenter.tsx`
- Create: `dashboard/src/components/ChatMessage.tsx`
- Create: `dashboard/src/hooks/useComms.ts`

- [ ] **Step 1: Create useComms hook**

Fetches: message threads (grouped by channel/agent pair), escalations, meetings. Subscribes to `message:new`, `meeting:started`, `meeting:turn`, `meeting:ended` SSE events.

- [ ] **Step 2: Create ChatMessage component**

Message bubble with: agent avatar (left-aligned for agents, right-aligned for user), message text, timestamp, role color (blue = manager, green = employee, purple = user). Support markdown rendering for code blocks.

- [ ] **Step 3: Create CommsCenter view**

Layout:
- Left sidebar (280px): thread list with tabs (Messages / Escalations / Meetings). Each thread shows: agent name, last message preview, timestamp, unread indicator. Active meetings show pulsing blue dot.
- Right panel: active conversation. Messages rendered as ChatMessage components. Input bar at bottom for user replies.

Meeting mode:
- Active meeting header: participant avatars with role-colored borders, "End Meeting" button
- Messages auto-scroll on `meeting:turn` SSE events
- User can type message -> `POST .../meetings/:id/message`
- "End Meeting" -> `POST .../meetings/:id/end`

- [ ] **Step 4: Create "New Meeting" flow**

"New Meeting" button -> modal: select participants (checkbox list of agents), optional prompt/topic. Submit -> `POST .../meetings/create`.

- [ ] **Step 5: Build and test**

Verify thread list loads. Verify message display. Verify meeting mode works end-to-end with SSE updates.

---

### Task 5.2: Config Editor

**Goal:** Visual config editing with tabs for agents, budget, tool gates, initiatives, jobs, safety. Every change shows cost delta + consequence + risk.

**Files:**
- Create: `dashboard/src/views/ConfigEditor.tsx`
- Create: `dashboard/src/components/BriefingBuilder.tsx`
- Create: `dashboard/src/components/BudgetSlider.tsx`
- Create: `dashboard/src/components/CostPreview.tsx`
- Create: `dashboard/src/components/YamlPreview.tsx`
- Create: `dashboard/src/hooks/useConfig.ts`

- [ ] **Step 1: Create useConfig hook**

Fetches: current config via `GET .../config`. Tracks unsaved changes. Provides:
- `save(section, data)` -> `POST .../config/save`
- `validate(section, data)` -> `POST .../config/validate`
- `preview(currentConfig, proposedConfig)` -> `POST .../config/preview` -> returns `ConfigChangePreview`
- Dirty state tracking per section. SSE `config:changed` for multi-tab sync.

- [ ] **Step 2: Create CostPreview component**

Displays `ConfigChangePreview` result:
- Cost delta: "+$X.XX/day" (green if cheaper, red if more expensive)
- Consequence: human-readable text
- Risk badge: LOW/MEDIUM/HIGH with explanation tooltip
- Historical context: if available, "Last time this changed, X happened"

Three-bucket breakdown (Management / Execution / Intelligence) when applicable. Each bucket expandable to show per-component detail.

- [ ] **Step 3: Create YamlPreview component**

Shows YAML diff of current vs proposed config. Syntax highlighted. Added lines green, removed lines red.

- [ ] **Step 4: Create BudgetSlider component**

Range slider with: current value display, min/max labels, dollar equivalent label. Live utilization overlay (shows how much of the limit is currently used). Dragging triggers a debounced `preview()` call to show cost impact.

- [ ] **Step 5: Create BriefingBuilder component**

Two zones: "Active" (top) and "Available" (bottom). Draggable chips representing briefing sources. Drag from Available to Active to enable, drag out to disable. Uses dnd-kit.

- [ ] **Step 6: Create ConfigEditor view — Agents tab**

Layout:
- Left sidebar: agent list with role indicators (blue dot = manager, green = employee), unsaved changes badge
- Right panel: form editor for selected agent
  - Editable: title, persona (textarea), reports_to (dropdown), department, team, channel
  - Briefing sources: BriefingBuilder
  - Expectations: add/remove list
  - Performance policy: dropdowns (action, max_retries, then)
- Bottom: YamlPreview showing diff from defaults
- Footer: "Save & Apply" button with unsaved indicator, CostPreview panel

- [ ] **Step 7: Create ConfigEditor view — Budget tab**

Layout:
- Operational profile selector: 4 cards (Low/Medium/High/Ultra) with summary and estimated cost per day. Click selects.
- Daily limits: 3 BudgetSliders (cents, tokens, requests) with live utilization overlay
- Hourly + Monthly: compact 3-column inputs
- Initiative allocation: stacked bar visualization + individual sliders with dollar equivalents
- CostPreview at bottom showing three-bucket breakdown

- [ ] **Step 8: Create ConfigEditor view — remaining tabs**

- **Tool Gates**: grid of tools x risk tiers. Click cell to change tier. Categories grouped.
- **Initiatives**: initiative list with allocation sliders, goal assignment.
- **Jobs**: job list per agent with cron editor, enable/disable toggle. Visual cron builder.
- **Safety**: sliders for circuit breaker multiplier, spawn depth, loop detection threshold. Each shows current, default, and consequence.

- [ ] **Step 9: Build and test**

Verify agent editing saves correctly. Verify budget sliders show cost preview. Verify YAML preview renders. Verify config save triggers `config:changed` SSE to other tabs.

---

## Phase 5.3: Initiative Deep Dive (Bonus)

**Goal:** Per-initiative focused view accessible from Command Center initiative cards.

**Files:**
- Create: `dashboard/src/views/InitiativeView.tsx`

- [ ] **Step 1: Create InitiativeView**

Layout:
- Budget: allocation vs spend, burn rate chart (recharts AreaChart), forecast to exhaustion date
- Task board: filtered TaskBoard showing only this initiative's goal tree tasks
- Agents: list of agents working on this initiative with status/performance
- Timeline: ActivityFeed scoped to this initiative
- Goal tree: hierarchical view of sub-goals with completion status bars

This view reuses components from Phase 2-4: ActivityFeed, TaskCard, recharts.

- [ ] **Step 2: Build and test**

Verify clicking initiative card on Command Center navigates here. Verify scoped data loads correctly.

---

## Cross-cutting Concerns

### Build Pipeline

The `dashboard/dist/` output must be committed or built at install time. Options:
1. **Pre-commit build:** Run `cd dashboard && npm run build` before publishing. Include `dist/` in package.
2. **Postinstall build:** Add a `postinstall` script. Slower but guarantees fresh build.

Recommendation: Option 1. Add `dashboard/dist/` to the git repo. Add a `build:dashboard` script to root `package.json`.

### Error Handling

All API calls wrapped in try/catch. Failed requests show a toast notification (non-blocking). Network errors trigger SSE reconnect with exponential backoff. Loading states use skeleton UI (not spinners).

### Responsive Design

Not mobile-first but functional on tablets. Sidebar collapses below 768px. Cards stack vertically. Data tables get horizontal scroll.

### Testing Strategy

- Backend: vitest unit tests for SSE, actions, extended queries, gateway-routes (Phase 1)
- Frontend: manual testing during development. Component tests can be added later with vitest + testing-library.
- Integration: manual end-to-end test with running OpenClaw gateway after each phase.
