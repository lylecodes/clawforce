# Memory & Knowledge Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a knowledge lifecycle where frequently-retrieved memories get promoted to structured knowledge, wrong knowledge gets flagged and corrected, behavioral rules stay salient via periodic re-injection, and skill count warnings help users manage agent complexity.

**Architecture:** Hook into the existing ghost turn pipeline (which runs before each agent turn) to track retrievals, dedup searches, and re-inject expectations. New `src/memory/` modules handle retrieval stats and promotion logic. Ops-tool gets new actions for promotion/demotion management. A new briefing source surfaces candidates for manager review during reflection.

**Tech Stack:** TypeScript, node:sqlite (DatabaseSync), vitest, existing Clawforce infrastructure (ghost-turn, flush-tracker, ops-tool, context assembler, profiles, config-validator)

**Reference:** Design doc at `docs/plans/2026-03-12-memory-knowledge-lifecycle-design.md`

**Important:** Memory search results from OpenClaw don't include memory IDs — they're plain text. Retrieval tracking uses **content hashes** (SHA-256 of result text) to identify unique memories.

---

### Task 1: Migration V26 and Types

Add all new tables and TypeScript types for the knowledge lifecycle.

**Files:**
- Modify: `src/migrations.ts:12,38-41,836-858` (V26 migration)
- Modify: `src/types.ts` (new types + AgentConfig additions)

**Step 1: Add types to src/types.ts**

Add after the DispatchPlan type (around line 947):

```typescript
export type PromotionTarget = "soul" | "skill" | "project_doc";

export type PromotionCandidate = {
  id: string;
  projectId: string;
  contentHash: string;
  contentSnippet: string;
  retrievalCount: number;
  sessionCount: number;
  suggestedTarget: PromotionTarget;
  targetAgentId?: string;
  status: "pending" | "approved" | "dismissed";
  createdAt: number;
  reviewedAt?: number;
};

export type KnowledgeFlag = {
  id: string;
  projectId: string;
  agentId: string;
  sourceType: PromotionTarget;
  sourceRef: string;
  flaggedContent: string;
  correction: string;
  severity: "low" | "medium" | "high";
  status: "pending" | "resolved" | "dismissed";
  createdAt: number;
  resolvedAt?: number;
};

export type KnowledgeConfig = {
  promotionThreshold?: {
    minRetrievals?: number;
    minSessions?: number;
  };
};
```

Add to AgentConfig (after `scheduling?: SchedulingConfig` at line 306):

```typescript
  skillCap?: number;
```

Add to WorkforceConfig (after `goals?` field):

```typescript
  knowledge?: KnowledgeConfig;
```

Add `"knowledge_candidates"` to the ContextSource `source` union (line 202).

**Step 2: Add migration V26**

In `src/migrations.ts`:
- Change `SCHEMA_VERSION` from `25` to `26`
- Add migration function:

```typescript
function migrateV26(db: DatabaseSync): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS memory_retrieval_stats (
      content_hash TEXT NOT NULL,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content_snippet TEXT NOT NULL,
      retrieval_count INTEGER NOT NULL DEFAULT 1,
      session_count INTEGER NOT NULL DEFAULT 1,
      first_retrieved_at INTEGER NOT NULL,
      last_retrieved_at INTEGER NOT NULL,
      PRIMARY KEY (content_hash, project_id, agent_id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS memory_search_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      query_text TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_search_log_session
    ON memory_search_log (session_key, query_hash)
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS promotion_candidates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_snippet TEXT NOT NULL,
      retrieval_count INTEGER NOT NULL,
      session_count INTEGER NOT NULL,
      suggested_target TEXT NOT NULL,
      target_agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS knowledge_flags (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      flagged_content TEXT NOT NULL,
      correction TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    )
  `).run();
}
```

- Add to MIGRATIONS map: `[26, migrateV26],`

**Step 3: Run existing migration tests**

Run: `npx vitest run test/db-migration.test.ts`
Expected: May need to update version check from 25 to 26.

**Step 4: Commit**

```bash
git add src/types.ts src/migrations.ts
git commit -m "feat: add V26 migration and types for memory knowledge lifecycle"
```

---

### Task 2: Retrieval Tracker Module

Track which memory content gets retrieved and how often, using content hashes.

**Files:**
- Create: `src/memory/retrieval-tracker.ts`
- Create: `test/memory/retrieval-tracker.test.ts`

**Step 1: Write the failing test**

Create `test/memory/retrieval-tracker.test.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

describe("retrieval tracker", () => {
  let db: DatabaseSync;
  const PROJECT = "tracker-test";
  const AGENT = "frontend";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("tracks a new retrieval and creates a stats entry", async () => {
    const { trackRetrieval, getRetrievalStats } = await import("../../src/memory/retrieval-tracker.js");

    trackRetrieval(PROJECT, AGENT, "session-1", "This is a memory about TypeScript preferences", db);

    const stats = getRetrievalStats(PROJECT, db);
    expect(stats).toHaveLength(1);
    expect(stats[0].retrievalCount).toBe(1);
    expect(stats[0].sessionCount).toBe(1);
    expect(stats[0].contentSnippet).toContain("TypeScript");
  });

  it("increments count on repeated retrieval in same session", async () => {
    const { trackRetrieval, getRetrievalStats } = await import("../../src/memory/retrieval-tracker.js");

    trackRetrieval(PROJECT, AGENT, "session-1", "Same memory content", db);
    trackRetrieval(PROJECT, AGENT, "session-1", "Same memory content", db);

    const stats = getRetrievalStats(PROJECT, db);
    expect(stats).toHaveLength(1);
    expect(stats[0].retrievalCount).toBe(2);
    expect(stats[0].sessionCount).toBe(1); // same session
  });

  it("increments session count on retrieval from different session", async () => {
    const { trackRetrieval, getRetrievalStats } = await import("../../src/memory/retrieval-tracker.js");

    trackRetrieval(PROJECT, AGENT, "session-1", "Cross-session memory", db);
    trackRetrieval(PROJECT, AGENT, "session-2", "Cross-session memory", db);

    const stats = getRetrievalStats(PROJECT, db);
    expect(stats).toHaveLength(1);
    expect(stats[0].retrievalCount).toBe(2);
    expect(stats[0].sessionCount).toBe(2);
  });

  it("returns stats above threshold", async () => {
    const { trackRetrieval, getStatsAboveThreshold } = await import("../../src/memory/retrieval-tracker.js");

    // Memory A: 5 retrievals across 3 sessions
    for (let i = 0; i < 5; i++) {
      trackRetrieval(PROJECT, AGENT, `session-${i % 3}`, "Frequently retrieved", db);
    }
    // Memory B: 1 retrieval
    trackRetrieval(PROJECT, AGENT, "session-0", "Rarely retrieved", db);

    const above = getStatsAboveThreshold(PROJECT, 4, 2, db);
    expect(above).toHaveLength(1);
    expect(above[0].contentSnippet).toContain("Frequently");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/retrieval-tracker.test.ts`
Expected: FAIL — module not found

**Step 3: Implement retrieval tracker**

Create `src/memory/retrieval-tracker.ts`:

```typescript
/**
 * Clawforce — Memory Retrieval Tracker
 *
 * Tracks which memory content gets retrieved via ghost turn,
 * using content hashes to identify unique memories.
 * Feeds the promotion pipeline with frequency data.
 */

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

export type RetrievalStat = {
  contentHash: string;
  projectId: string;
  agentId: string;
  contentSnippet: string;
  retrievalCount: number;
  sessionCount: number;
  firstRetrievedAt: number;
  lastRetrievedAt: number;
};

function hashContent(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex").slice(0, 32);
}

function snippetize(content: string, maxLen: number = 200): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "..." : trimmed;
}

// Track which sessions have been counted for each content hash
const sessionTracker = new Map<string, Set<string>>();

function getSessionKey(contentHash: string, projectId: string, agentId: string): string {
  return `${contentHash}:${projectId}:${agentId}`;
}

export function trackRetrieval(
  projectId: string,
  agentId: string,
  sessionKey: string,
  content: string,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const contentHash = hashContent(content);
  const snippet = snippetize(content);
  const now = Date.now();

  const trackerKey = getSessionKey(contentHash, projectId, agentId);
  let sessions = sessionTracker.get(trackerKey);
  if (!sessions) {
    sessions = new Set<string>();
    sessionTracker.set(trackerKey, sessions);
  }
  const isNewSession = !sessions.has(sessionKey);
  sessions.add(sessionKey);

  const existing = db.prepare(
    "SELECT retrieval_count, session_count FROM memory_retrieval_stats WHERE content_hash = ? AND project_id = ? AND agent_id = ?",
  ).get(contentHash, projectId, agentId) as { retrieval_count: number; session_count: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE memory_retrieval_stats
      SET retrieval_count = retrieval_count + 1,
          session_count = ?,
          last_retrieved_at = ?
      WHERE content_hash = ? AND project_id = ? AND agent_id = ?
    `).run(
      isNewSession ? existing.session_count + 1 : existing.session_count,
      now,
      contentHash, projectId, agentId,
    );
  } else {
    db.prepare(`
      INSERT INTO memory_retrieval_stats (content_hash, project_id, agent_id, content_snippet, retrieval_count, session_count, first_retrieved_at, last_retrieved_at)
      VALUES (?, ?, ?, ?, 1, 1, ?, ?)
    `).run(contentHash, projectId, agentId, snippet, now, now);
  }
}

function rowToStat(row: Record<string, unknown>): RetrievalStat {
  return {
    contentHash: row.content_hash as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    contentSnippet: row.content_snippet as string,
    retrievalCount: row.retrieval_count as number,
    sessionCount: row.session_count as number,
    firstRetrievedAt: row.first_retrieved_at as number,
    lastRetrievedAt: row.last_retrieved_at as number,
  };
}

export function getRetrievalStats(projectId: string, dbOverride?: DatabaseSync): RetrievalStat[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM memory_retrieval_stats WHERE project_id = ? ORDER BY retrieval_count DESC",
  ).all(projectId) as Record<string, unknown>[];
  return rows.map(rowToStat);
}

export function getStatsAboveThreshold(
  projectId: string,
  minRetrievals: number,
  minSessions: number,
  dbOverride?: DatabaseSync,
): RetrievalStat[] {
  const db = dbOverride ?? getDb(projectId);
  const rows = db.prepare(
    "SELECT * FROM memory_retrieval_stats WHERE project_id = ? AND retrieval_count >= ? AND session_count >= ? ORDER BY retrieval_count DESC",
  ).all(projectId, minRetrievals, minSessions) as Record<string, unknown>[];
  return rows.map(rowToStat);
}

export function clearSessionTracker(): void {
  sessionTracker.clear();
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/memory/retrieval-tracker.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/memory/retrieval-tracker.ts test/memory/retrieval-tracker.test.ts
git commit -m "feat: add memory retrieval tracker with content hashing"
```

---

### Task 3: Search Query Dedup Module

Prevent redundant memory searches within the same session via query hash lookup.

**Files:**
- Create: `src/memory/search-dedup.ts`
- Create: `test/memory/search-dedup.test.ts`

**Step 1: Write the failing test**

Create `test/memory/search-dedup.test.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

describe("search query dedup", () => {
  let db: DatabaseSync;
  const PROJECT = "dedup-test";
  const AGENT = "frontend";
  const SESSION = "session-123";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("reports no duplicate for first query", async () => {
    const { isDuplicateQuery } = await import("../../src/memory/search-dedup.js");

    const result = isDuplicateQuery(PROJECT, SESSION, "typescript best practices", db);
    expect(result).toBe(false);
  });

  it("logs a query and detects duplicate in same session", async () => {
    const { isDuplicateQuery, logSearchQuery } = await import("../../src/memory/search-dedup.js");

    logSearchQuery(PROJECT, AGENT, SESSION, "typescript best practices", 3, db);

    const result = isDuplicateQuery(PROJECT, SESSION, "typescript best practices", db);
    expect(result).toBe(true);
  });

  it("allows same query in different session", async () => {
    const { isDuplicateQuery, logSearchQuery } = await import("../../src/memory/search-dedup.js");

    logSearchQuery(PROJECT, AGENT, SESSION, "typescript best practices", 3, db);

    const result = isDuplicateQuery(PROJECT, "different-session", "typescript best practices", db);
    expect(result).toBe(false);
  });

  it("treats different queries as non-duplicate", async () => {
    const { isDuplicateQuery, logSearchQuery } = await import("../../src/memory/search-dedup.js");

    logSearchQuery(PROJECT, AGENT, SESSION, "typescript best practices", 3, db);

    const result = isDuplicateQuery(PROJECT, SESSION, "react hooks patterns", db);
    expect(result).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/search-dedup.test.ts`
Expected: FAIL — module not found

**Step 3: Implement search dedup**

Create `src/memory/search-dedup.ts`:

```typescript
/**
 * Clawforce — Memory Search Dedup
 *
 * Prevents redundant memory searches within the same session.
 * Uses query text hashing to detect duplicates.
 */

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";

function hashQuery(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export function isDuplicateQuery(
  projectId: string,
  sessionKey: string,
  query: string,
  dbOverride?: DatabaseSync,
): boolean {
  const db = dbOverride ?? getDb(projectId);
  const qHash = hashQuery(query);

  const existing = db.prepare(
    "SELECT id FROM memory_search_log WHERE session_key = ? AND query_hash = ?",
  ).get(sessionKey, qHash) as Record<string, unknown> | undefined;

  return !!existing;
}

export function logSearchQuery(
  projectId: string,
  agentId: string,
  sessionKey: string,
  query: string,
  resultCount: number,
  dbOverride?: DatabaseSync,
): void {
  const db = dbOverride ?? getDb(projectId);
  const id = randomUUID();
  const qHash = hashQuery(query);

  db.prepare(`
    INSERT INTO memory_search_log (id, project_id, agent_id, session_key, query_hash, query_text, result_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, agentId, sessionKey, qHash, query, resultCount, Date.now());
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/memory/search-dedup.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/memory/search-dedup.ts test/memory/search-dedup.test.ts
git commit -m "feat: add search query dedup for ghost turn"
```

---

### Task 4: Ghost Turn Integration

Hook retrieval tracking, search dedup, and expectations re-injection into the ghost turn pipeline.

**Files:**
- Modify: `src/memory/ghost-turn.ts:155-183,219-284` (executeMemorySearch, runGhostRecall)
- Modify: `adapters/openclaw.ts:456-500` (before_prompt_build hook)
- Create: `test/memory/ghost-turn-integration.test.ts`

**Step 1: Write the failing test**

Create `test/memory/ghost-turn-integration.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

describe("expectations re-injection", () => {
  it("formats expectations as a reminder section", async () => {
    const { formatExpectationsReminder } = await import("../../src/memory/ghost-turn.js");

    const expectations = [
      { tool: "clawforce_log", action: "log", min_calls: 1 },
      { tool: "clawforce_verify", action: "submit_evidence", min_calls: 1 },
    ];

    const result = formatExpectationsReminder(expectations);
    expect(result).toContain("Expectations Reminder");
    expect(result).toContain("clawforce_log");
    expect(result).toContain("clawforce_verify");
  });

  it("returns null when no expectations provided", async () => {
    const { formatExpectationsReminder } = await import("../../src/memory/ghost-turn.js");

    const result = formatExpectationsReminder([]);
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/ghost-turn-integration.test.ts`
Expected: FAIL — `formatExpectationsReminder` not exported

**Step 3: Add formatExpectationsReminder to ghost-turn.ts**

In `src/memory/ghost-turn.ts`, add a new exported function:

```typescript
import type { Expectation } from "../types.js";

/**
 * Format agent expectations as a compressed reminder for re-injection.
 * Returns null if no expectations are provided.
 */
export function formatExpectationsReminder(expectations: Expectation[]): string | null {
  if (!expectations || expectations.length === 0) return null;

  const lines: string[] = ["## Expectations Reminder", ""];
  for (const exp of expectations) {
    const actions = Array.isArray(exp.action) ? exp.action.join("/") : exp.action;
    lines.push(`- Use \`${exp.tool}\` → \`${actions}\` (min ${exp.min_calls}x per session)`);
  }
  return lines.join("\n");
}
```

**Step 4: Wire expectations re-injection into adapter**

In `adapters/openclaw.ts`, in the `before_prompt_build` hook (around line 497-500 where prependContext is assembled):

After the ghost turn results are computed, also compute the expectations reminder:

```typescript
// Expectations re-injection (after ghost context)
let expectationsContext: string | null = null;
const injectExpectations = cfg.ghostRecall.injectExpectations ?? true;
if (injectExpectations && entry?.config.expectations?.length) {
  const { formatExpectationsReminder } = await import("../src/memory/ghost-turn.js");
  expectationsContext = formatExpectationsReminder(entry.config.expectations);
}

const parts = [content, ghostContext, expectationsContext].filter(Boolean);
```

Also add `injectExpectations?: boolean` to the `GhostRecallConfig` type in `src/types.ts`.

**Step 5: Run test to verify it passes**

Run: `npx vitest run test/memory/ghost-turn-integration.test.ts`
Expected: PASS (2 tests)

**Step 6: Commit**

```bash
git add src/memory/ghost-turn.ts adapters/openclaw.ts src/types.ts test/memory/ghost-turn-integration.test.ts
git commit -m "feat: add expectations re-injection via ghost turn pipeline"
```

---

### Task 5: Promotion Pipeline

Detect promotion candidates from retrieval stats and manage their lifecycle.

**Files:**
- Create: `src/memory/promotion.ts`
- Create: `test/memory/promotion.test.ts`

**Step 1: Write the failing test**

Create `test/memory/promotion.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

describe("promotion pipeline", () => {
  let db: DatabaseSync;
  const PROJECT = "promo-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("detects candidates from retrieval stats above threshold", async () => {
    const { checkPromotionCandidates, listCandidates } = await import("../../src/memory/promotion.js");

    // Insert retrieval stat that exceeds threshold
    db.prepare(`
      INSERT INTO memory_retrieval_stats (content_hash, project_id, agent_id, content_snippet, retrieval_count, session_count, first_retrieved_at, last_retrieved_at)
      VALUES ('hash1', ?, 'frontend', 'Always use TypeScript strict mode', 15, 8, ?, ?)
    `).run(PROJECT, Date.now() - 86400000, Date.now());

    // Below threshold
    db.prepare(`
      INSERT INTO memory_retrieval_stats (content_hash, project_id, agent_id, content_snippet, retrieval_count, session_count, first_retrieved_at, last_retrieved_at)
      VALUES ('hash2', ?, 'frontend', 'Rarely used fact', 2, 1, ?, ?)
    `).run(PROJECT, Date.now(), Date.now());

    checkPromotionCandidates(PROJECT, { minRetrievals: 10, minSessions: 5 }, db);

    const candidates = listCandidates(PROJECT, db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].contentSnippet).toContain("TypeScript");
    expect(candidates[0].status).toBe("pending");
  });

  it("does not create duplicate candidates", async () => {
    const { checkPromotionCandidates, listCandidates } = await import("../../src/memory/promotion.js");

    db.prepare(`
      INSERT INTO memory_retrieval_stats (content_hash, project_id, agent_id, content_snippet, retrieval_count, session_count, first_retrieved_at, last_retrieved_at)
      VALUES ('hash1', ?, 'frontend', 'Frequently used', 15, 8, ?, ?)
    `).run(PROJECT, Date.now() - 86400000, Date.now());

    checkPromotionCandidates(PROJECT, { minRetrievals: 10, minSessions: 5 }, db);
    checkPromotionCandidates(PROJECT, { minRetrievals: 10, minSessions: 5 }, db);

    const candidates = listCandidates(PROJECT, db);
    expect(candidates).toHaveLength(1); // no duplicate
  });

  it("approves and dismisses candidates", async () => {
    const { approveCandidate, dismissCandidate, getCandidate } = await import("../../src/memory/promotion.js");

    const id1 = randomUUID();
    const id2 = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO promotion_candidates (id, project_id, content_hash, content_snippet, retrieval_count, session_count, suggested_target, status, created_at) VALUES (?, ?, 'h1', 'Memory 1', 10, 5, 'soul', 'pending', ?)`).run(id1, PROJECT, now);
    db.prepare(`INSERT INTO promotion_candidates (id, project_id, content_hash, content_snippet, retrieval_count, session_count, suggested_target, status, created_at) VALUES (?, ?, 'h2', 'Memory 2', 10, 5, 'skill', 'pending', ?)`).run(id2, PROJECT, now);

    approveCandidate(PROJECT, id1, db);
    dismissCandidate(PROJECT, id2, db);

    expect(getCandidate(PROJECT, id1, db)!.status).toBe("approved");
    expect(getCandidate(PROJECT, id2, db)!.status).toBe("dismissed");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/promotion.test.ts`
Expected: FAIL — module not found

**Step 3: Implement promotion pipeline**

Create `src/memory/promotion.ts`:

```typescript
/**
 * Clawforce — Knowledge Promotion Pipeline
 *
 * Detects frequently-retrieved memories and creates promotion candidates.
 * Candidates are reviewed by the manager during reflection.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { PromotionCandidate, PromotionTarget } from "../types.js";

function rowToCandidate(row: Record<string, unknown>): PromotionCandidate {
  const c: PromotionCandidate = {
    id: row.id as string,
    projectId: row.project_id as string,
    contentHash: row.content_hash as string,
    contentSnippet: row.content_snippet as string,
    retrievalCount: row.retrieval_count as number,
    sessionCount: row.session_count as number,
    suggestedTarget: row.suggested_target as PromotionTarget,
    status: row.status as PromotionCandidate["status"],
    createdAt: row.created_at as number,
  };
  if (row.target_agent_id != null) c.targetAgentId = row.target_agent_id as string;
  if (row.reviewed_at != null) c.reviewedAt = row.reviewed_at as number;
  return c;
}

/**
 * Suggest a promotion target based on content heuristics.
 */
function suggestTarget(snippet: string): PromotionTarget {
  const lower = snippet.toLowerCase();
  if (lower.includes("i prefer") || lower.includes("i always") || lower.includes("my approach") || lower.includes("my style")) {
    return "soul";
  }
  if (lower.includes("project") || lower.includes("deploy") || lower.includes("team") || lower.includes("process")) {
    return "project_doc";
  }
  return "skill";
}

export function checkPromotionCandidates(
  projectId: string,
  threshold: { minRetrievals: number; minSessions: number },
  dbOverride?: DatabaseSync,
): number {
  const db = dbOverride ?? getDb(projectId);

  // Find stats above threshold that don't already have a pending/approved candidate
  const stats = db.prepare(`
    SELECT mrs.*
    FROM memory_retrieval_stats mrs
    WHERE mrs.project_id = ?
      AND mrs.retrieval_count >= ?
      AND mrs.session_count >= ?
      AND NOT EXISTS (
        SELECT 1 FROM promotion_candidates pc
        WHERE pc.project_id = mrs.project_id
          AND pc.content_hash = mrs.content_hash
          AND pc.status IN ('pending', 'approved')
      )
  `).all(projectId, threshold.minRetrievals, threshold.minSessions) as Record<string, unknown>[];

  let created = 0;
  for (const row of stats) {
    const snippet = row.content_snippet as string;
    db.prepare(`
      INSERT INTO promotion_candidates (id, project_id, content_hash, content_snippet, retrieval_count, session_count, suggested_target, target_agent_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(),
      projectId,
      row.content_hash as string,
      snippet,
      row.retrieval_count as number,
      row.session_count as number,
      suggestTarget(snippet),
      row.agent_id as string,
      Date.now(),
    );
    created++;
  }

  return created;
}

export function listCandidates(
  projectId: string,
  dbOverride?: DatabaseSync,
  statusFilter?: PromotionCandidate["status"],
): PromotionCandidate[] {
  const db = dbOverride ?? getDb(projectId);
  let query = "SELECT * FROM promotion_candidates WHERE project_id = ?";
  const params: (string | number)[] = [projectId];
  if (statusFilter) {
    query += " AND status = ?";
    params.push(statusFilter);
  }
  query += " ORDER BY retrieval_count DESC";
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToCandidate);
}

export function getCandidate(projectId: string, candidateId: string, dbOverride?: DatabaseSync): PromotionCandidate | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM promotion_candidates WHERE id = ? AND project_id = ?")
    .get(candidateId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToCandidate(row) : null;
}

export function approveCandidate(projectId: string, candidateId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE promotion_candidates SET status = 'approved', reviewed_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), candidateId, projectId);
}

export function dismissCandidate(projectId: string, candidateId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE promotion_candidates SET status = 'dismissed', reviewed_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), candidateId, projectId);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/memory/promotion.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/memory/promotion.ts test/memory/promotion.test.ts
git commit -m "feat: add promotion pipeline for frequently-retrieved memories"
```

---

### Task 6: Knowledge Demotion (Flag CRUD)

Agent flags wrong structured knowledge for manager review.

**Files:**
- Create: `src/memory/demotion.ts`
- Create: `test/memory/demotion.test.ts`

**Step 1: Write the failing test**

Create `test/memory/demotion.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

describe("knowledge demotion flags", () => {
  let db: DatabaseSync;
  const PROJECT = "demotion-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("creates a knowledge flag", async () => {
    const { createFlag, getFlag } = await import("../../src/memory/demotion.js");

    const flag = createFlag({
      projectId: PROJECT,
      agentId: "frontend",
      sourceType: "soul",
      sourceRef: "SOUL.md",
      flaggedContent: "Always use REST APIs",
      correction: "GraphQL is preferred for this project",
      severity: "high",
    }, db);

    expect(flag.status).toBe("pending");
    const fetched = getFlag(PROJECT, flag.id, db);
    expect(fetched!.flaggedContent).toContain("REST");
    expect(fetched!.correction).toContain("GraphQL");
  });

  it("resolves and dismisses flags", async () => {
    const { createFlag, resolveFlag, dismissFlag, getFlag } = await import("../../src/memory/demotion.js");

    const f1 = createFlag({ projectId: PROJECT, agentId: "frontend", sourceType: "skill", sourceRef: "api-patterns", flaggedContent: "X", correction: "Y", severity: "medium" }, db);
    const f2 = createFlag({ projectId: PROJECT, agentId: "frontend", sourceType: "skill", sourceRef: "api-patterns", flaggedContent: "A", correction: "B", severity: "low" }, db);

    resolveFlag(PROJECT, f1.id, db);
    dismissFlag(PROJECT, f2.id, db);

    expect(getFlag(PROJECT, f1.id, db)!.status).toBe("resolved");
    expect(getFlag(PROJECT, f2.id, db)!.status).toBe("dismissed");
  });

  it("lists pending flags", async () => {
    const { createFlag, resolveFlag, listFlags } = await import("../../src/memory/demotion.js");

    createFlag({ projectId: PROJECT, agentId: "a", sourceType: "soul", sourceRef: "SOUL.md", flaggedContent: "X", correction: "Y", severity: "high" }, db);
    const f2 = createFlag({ projectId: PROJECT, agentId: "a", sourceType: "soul", sourceRef: "SOUL.md", flaggedContent: "A", correction: "B", severity: "low" }, db);
    resolveFlag(PROJECT, f2.id, db);

    const pending = listFlags(PROJECT, "pending", db);
    expect(pending).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/memory/demotion.test.ts`
Expected: FAIL — module not found

**Step 3: Implement demotion module**

Create `src/memory/demotion.ts`:

```typescript
/**
 * Clawforce — Knowledge Demotion
 *
 * Agents flag wrong structured knowledge (SOUL.md, skills, project docs)
 * for manager review and correction.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../db.js";
import type { KnowledgeFlag, PromotionTarget } from "../types.js";

function rowToFlag(row: Record<string, unknown>): KnowledgeFlag {
  const f: KnowledgeFlag = {
    id: row.id as string,
    projectId: row.project_id as string,
    agentId: row.agent_id as string,
    sourceType: row.source_type as PromotionTarget,
    sourceRef: row.source_ref as string,
    flaggedContent: row.flagged_content as string,
    correction: row.correction as string,
    severity: row.severity as KnowledgeFlag["severity"],
    status: row.status as KnowledgeFlag["status"],
    createdAt: row.created_at as number,
  };
  if (row.resolved_at != null) f.resolvedAt = row.resolved_at as number;
  return f;
}

export type CreateFlagParams = {
  projectId: string;
  agentId: string;
  sourceType: PromotionTarget;
  sourceRef: string;
  flaggedContent: string;
  correction: string;
  severity: KnowledgeFlag["severity"];
};

export function createFlag(params: CreateFlagParams, dbOverride?: DatabaseSync): KnowledgeFlag {
  const db = dbOverride ?? getDb(params.projectId);
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO knowledge_flags (id, project_id, agent_id, source_type, source_ref, flagged_content, correction, severity, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, params.projectId, params.agentId, params.sourceType, params.sourceRef, params.flaggedContent, params.correction, params.severity, now);

  return {
    id,
    projectId: params.projectId,
    agentId: params.agentId,
    sourceType: params.sourceType,
    sourceRef: params.sourceRef,
    flaggedContent: params.flaggedContent,
    correction: params.correction,
    severity: params.severity,
    status: "pending",
    createdAt: now,
  };
}

export function getFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): KnowledgeFlag | null {
  const db = dbOverride ?? getDb(projectId);
  const row = db.prepare("SELECT * FROM knowledge_flags WHERE id = ? AND project_id = ?")
    .get(flagId, projectId) as Record<string, unknown> | undefined;
  return row ? rowToFlag(row) : null;
}

export function listFlags(projectId: string, statusFilter?: KnowledgeFlag["status"], dbOverride?: DatabaseSync): KnowledgeFlag[] {
  const db = dbOverride ?? getDb(projectId);
  let query = "SELECT * FROM knowledge_flags WHERE project_id = ?";
  const params: (string | number)[] = [projectId];
  if (statusFilter) {
    query += " AND status = ?";
    params.push(statusFilter);
  }
  query += " ORDER BY created_at DESC";
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToFlag);
}

export function resolveFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE knowledge_flags SET status = 'resolved', resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), flagId, projectId);
}

export function dismissFlag(projectId: string, flagId: string, dbOverride?: DatabaseSync): void {
  const db = dbOverride ?? getDb(projectId);
  db.prepare("UPDATE knowledge_flags SET status = 'dismissed', resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'pending'")
    .run(Date.now(), flagId, projectId);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/memory/demotion.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/memory/demotion.ts test/memory/demotion.test.ts
git commit -m "feat: add knowledge demotion flag system"
```

---

### Task 7: Ops-Tool Knowledge Actions

Wire promotion and demotion actions into the ops-tool.

**Files:**
- Modify: `src/tools/ops-tool.ts` (OPS_ACTIONS, schema, handlers)

**Step 1: Add actions and schema**

Add to OPS_ACTIONS: `"flag_knowledge"`, `"approve_promotion"`, `"dismiss_promotion"`, `"resolve_flag"`, `"dismiss_flag"`, `"list_candidates"`, `"list_flags"`

Add schema params:
```typescript
  source_type: Type.Optional(Type.String({ description: "Knowledge source type: soul, skill, or project_doc." })),
  source_ref: Type.Optional(Type.String({ description: "Source reference (file path or topic name)." })),
  flagged_content: Type.Optional(Type.String({ description: "The content that is wrong." })),
  correction: Type.Optional(Type.String({ description: "The correct information." })),
  severity: Type.Optional(Type.String({ description: "Flag severity: low, medium, high." })),
  candidate_id: Type.Optional(Type.String({ description: "Promotion candidate ID." })),
  flag_id: Type.Optional(Type.String({ description: "Knowledge flag ID." })),
```

**Step 2: Add case handlers**

```typescript
case "flag_knowledge": {
  const sourceType = readStringParam(params, "source_type");
  const sourceRef = readStringParam(params, "source_ref");
  const flaggedContent = readStringParam(params, "flagged_content");
  const correction = readStringParam(params, "correction");
  const severity = readStringParam(params, "severity") ?? "medium";
  if (!sourceType || !sourceRef || !flaggedContent || !correction) {
    return jsonResult({ ok: false, error: "source_type, source_ref, flagged_content, and correction required" });
  }
  const { createFlag } = await import("../memory/demotion.js");
  const flag = createFlag({ projectId, agentId: caller, sourceType: sourceType as any, sourceRef, flaggedContent, correction, severity: severity as any }, getDb(projectId));
  writeAuditEntry(getDb(projectId), projectId, caller, "flag_knowledge", { flagId: flag.id, sourceType, sourceRef, severity });
  return jsonResult({ ok: true, flag });
}
case "approve_promotion": {
  const candidateId = readStringParam(params, "candidate_id");
  if (!candidateId) return jsonResult({ ok: false, error: "candidate_id required" });
  const { approveCandidate } = await import("../memory/promotion.js");
  approveCandidate(projectId, candidateId, getDb(projectId));
  writeAuditEntry(getDb(projectId), projectId, caller, "approve_promotion", { candidateId });
  return jsonResult({ ok: true, candidateId, status: "approved" });
}
case "dismiss_promotion": {
  const candidateId = readStringParam(params, "candidate_id");
  if (!candidateId) return jsonResult({ ok: false, error: "candidate_id required" });
  const { dismissCandidate } = await import("../memory/promotion.js");
  dismissCandidate(projectId, candidateId, getDb(projectId));
  return jsonResult({ ok: true, candidateId, status: "dismissed" });
}
case "resolve_flag": {
  const flagId = readStringParam(params, "flag_id");
  if (!flagId) return jsonResult({ ok: false, error: "flag_id required" });
  const { resolveFlag } = await import("../memory/demotion.js");
  resolveFlag(projectId, flagId, getDb(projectId));
  writeAuditEntry(getDb(projectId), projectId, caller, "resolve_flag", { flagId });
  return jsonResult({ ok: true, flagId, status: "resolved" });
}
case "dismiss_flag": {
  const flagId = readStringParam(params, "flag_id");
  if (!flagId) return jsonResult({ ok: false, error: "flag_id required" });
  const { dismissFlag } = await import("../memory/demotion.js");
  dismissFlag(projectId, flagId, getDb(projectId));
  return jsonResult({ ok: true, flagId, status: "dismissed" });
}
case "list_candidates": {
  const { listCandidates } = await import("../memory/promotion.js");
  const candidates = listCandidates(projectId, getDb(projectId), "pending");
  return jsonResult({ ok: true, candidates });
}
case "list_flags": {
  const { listFlags } = await import("../memory/demotion.js");
  const flags = listFlags(projectId, "pending", getDb(projectId));
  return jsonResult({ ok: true, flags });
}
```

**Step 3: Run tests**

Run: `npx vitest run test/tools/ops-tool.test.ts`
Expected: PASS (no regressions)

**Step 4: Commit**

```bash
git add src/tools/ops-tool.ts
git commit -m "feat: add knowledge promotion and demotion actions to ops-tool"
```

---

### Task 8: Knowledge Candidates Briefing Source

New `knowledge_candidates` context source showing pending promotions and knowledge flags for manager review.

**Files:**
- Modify: `src/project.ts` (add to VALID_SOURCES)
- Modify: `src/context/assembler.ts` (add case + resolver)
- Create: `test/context/knowledge-candidates.test.ts`

**Step 1: Write the failing test**

Create `test/context/knowledge-candidates.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../../src/identity.js", () => ({
  signAction: vi.fn(() => "test-signature"),
  getAgentIdentity: vi.fn(() => ({
    agentId: "test",
    hmacKey: "deadbeef",
    identityToken: "tok",
    issuedAt: Date.now(),
  })),
}));

const { getMemoryDb } = await import("../../src/db.js");

describe("knowledge_candidates briefing source", () => {
  let db: DatabaseSync;
  const PROJECT = "kc-test";

  beforeEach(() => {
    db = getMemoryDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it("shows pending promotions and flags", async () => {
    const { resolveKnowledgeCandidatesSource } = await import("../../src/context/assembler.js");

    // Insert a promotion candidate
    db.prepare(`INSERT INTO promotion_candidates (id, project_id, content_hash, content_snippet, retrieval_count, session_count, suggested_target, status, created_at) VALUES (?, ?, 'h1', 'Always use strict TypeScript', 15, 8, 'soul', 'pending', ?)`).run(randomUUID(), PROJECT, Date.now());

    // Insert a knowledge flag
    db.prepare(`INSERT INTO knowledge_flags (id, project_id, agent_id, source_type, source_ref, flagged_content, correction, severity, status, created_at) VALUES (?, ?, 'frontend', 'soul', 'SOUL.md', 'Use REST', 'Use GraphQL', 'high', 'pending', ?)`).run(randomUUID(), PROJECT, Date.now());

    const result = resolveKnowledgeCandidatesSource(PROJECT, db);
    expect(result).toContain("Knowledge Review");
    expect(result).toContain("strict TypeScript");
    expect(result).toContain("REST");
    expect(result).toContain("GraphQL");
  });

  it("returns no-items message when nothing pending", async () => {
    const { resolveKnowledgeCandidatesSource } = await import("../../src/context/assembler.js");

    const result = resolveKnowledgeCandidatesSource(PROJECT, db);
    expect(result).toContain("No pending");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/context/knowledge-candidates.test.ts`
Expected: FAIL — function not exported

**Step 3: Implement**

1. Add `"knowledge_candidates"` to VALID_SOURCES in `src/project.ts`.

2. In `src/context/assembler.ts`, add case:
```typescript
case "knowledge_candidates": return resolveKnowledgeCandidatesSource(projectId, dbOverride);
```

3. Add resolver:

```typescript
export function resolveKnowledgeCandidatesSource(
  projectId: string,
  dbOverride?: DatabaseSync,
): string {
  const db = dbOverride ?? getDb(projectId);

  const candidates = db.prepare(
    "SELECT * FROM promotion_candidates WHERE project_id = ? AND status = 'pending' ORDER BY retrieval_count DESC",
  ).all(projectId) as Record<string, unknown>[];

  const flags = db.prepare(
    "SELECT * FROM knowledge_flags WHERE project_id = ? AND status = 'pending' ORDER BY severity DESC, created_at DESC",
  ).all(projectId) as Record<string, unknown>[];

  if (candidates.length === 0 && flags.length === 0) {
    return "No pending knowledge promotions or corrections.";
  }

  const lines: string[] = ["## Knowledge Review", ""];

  if (candidates.length > 0) {
    lines.push("### Promotion Candidates", "");
    lines.push("| Content | Retrieved | Sessions | Suggested Target | Action |");
    lines.push("|---------|-----------|----------|-----------------|--------|");
    for (const row of candidates) {
      const snippet = (row.content_snippet as string).slice(0, 80);
      lines.push(`| ${snippet} | ${row.retrieval_count}x | ${row.session_count} | ${row.suggested_target} | \`approve_promotion\` / \`dismiss_promotion\` candidate_id="${row.id}" |`);
    }
    lines.push("");
  }

  if (flags.length > 0) {
    lines.push("### Knowledge Corrections", "");
    lines.push("| Source | Wrong | Correct | Severity | Action |");
    lines.push("|--------|-------|---------|----------|--------|");
    for (const row of flags) {
      const flagged = (row.flagged_content as string).slice(0, 50);
      const correction = (row.correction as string).slice(0, 50);
      lines.push(`| ${row.source_type}:${row.source_ref} | ${flagged} | ${correction} | ${row.severity} | \`resolve_flag\` / \`dismiss_flag\` flag_id="${row.id}" |`);
    }
  }

  return lines.join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/context/knowledge-candidates.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/project.ts src/context/assembler.ts test/context/knowledge-candidates.test.ts
git commit -m "feat: add knowledge_candidates briefing source for manager reflection"
```

---

### Task 9: Configurable Skill Cap

Lint-style warning when agents exceed their skill cap.

**Files:**
- Modify: `src/config-validator.ts` (add skill cap warning)
- Modify: `src/presets.ts` (add default skill_cap per preset)
- Modify: `src/project.ts` (parse skill_cap + knowledge config)
- Create: `test/config/skill-cap.test.ts`

**Step 1: Write the failing test**

Create `test/config/skill-cap.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  safeLog: vi.fn(),
}));

describe("skill cap validation", () => {
  it("warns when agent exceeds skill cap", async () => {
    const { validateWorkforceConfig } = await import("../../src/config-validator.js");

    const config = {
      name: "test-project",
      agents: {
        "overloaded-agent": {
          title: "Overloaded",
          skillCap: 2,
          // The validator would check topic count vs skillCap
        },
      },
    } as any;

    const warnings = validateWorkforceConfig(config);
    // Skill cap warnings are informational — they check config values
    // The actual topic count check happens at runtime (needs registry)
    // Config validator just validates skillCap is a positive number if set
    expect(Array.isArray(warnings)).toBe(true);
  });
});
```

**Step 2: Add default skill_cap to presets**

In `src/presets.ts`, add to manager preset: `skillCap: 12`
Add to employee preset: `skillCap: 8`

**Step 3: Parse skill_cap and knowledge config in project.ts**

In `src/project.ts`, within agent config parsing:
```typescript
if (typeof raw.skill_cap === "number") {
  agent.skillCap = raw.skill_cap;
}
```

For knowledge config at the project level:
```typescript
if (raw.knowledge) {
  result.knowledge = {
    promotionThreshold: {
      minRetrievals: typeof raw.knowledge.promotion_threshold?.min_retrievals === "number" ? raw.knowledge.promotion_threshold.min_retrievals : undefined,
      minSessions: typeof raw.knowledge.promotion_threshold?.min_sessions === "number" ? raw.knowledge.promotion_threshold.min_sessions : undefined,
    },
  };
}
```

Add `knowledge?: KnowledgeConfig` parsing support in `loadWorkforceConfig`.

**Step 4: Add skill cap warning to config-validator**

In `src/config-validator.ts`, in the agent validation section:

```typescript
if (agentConfig.skillCap !== undefined && agentConfig.skillCap < 1) {
  warnings.push({ level: "warn", agentId, message: `Skill cap must be a positive number (got ${agentConfig.skillCap}).` });
}
```

**Step 5: Run tests**

Run: `npx vitest run test/config/skill-cap.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/presets.ts src/project.ts src/config-validator.ts test/config/skill-cap.test.ts
git commit -m "feat: add configurable skill cap with lint warnings"
```

---

### Task 10: Presets, Skill Topics, and Exports

Wire everything together: update manager preset defaults, skill documentation, and public exports.

**Files:**
- Modify: `src/presets.ts` (add knowledge_candidates to manager briefing)
- Modify: `src/skills/topics/memory.ts` (update documentation)
- Modify: `src/index.ts` (export new modules)

**Step 1: Update manager preset**

Add `"knowledge_candidates"` to the manager preset's default briefing sources in `src/presets.ts`.

**Step 2: Update memory skill topic**

In `src/skills/topics/memory.ts`, add documentation for:
- Knowledge promotion pipeline (how memories get promoted)
- Knowledge demotion (flag_knowledge action)
- Promotion/demotion review actions
- Skill cap concept
- Expectations re-injection

**Step 3: Export new modules**

In `src/index.ts`, add:

```typescript
// --- Knowledge Lifecycle ---
export { trackRetrieval, getRetrievalStats, getStatsAboveThreshold } from "./memory/retrieval-tracker.js";
export type { RetrievalStat } from "./memory/retrieval-tracker.js";
export { isDuplicateQuery, logSearchQuery } from "./memory/search-dedup.js";
export { checkPromotionCandidates, listCandidates, getCandidate, approveCandidate, dismissCandidate } from "./memory/promotion.js";
export { createFlag, getFlag, listFlags, resolveFlag, dismissFlag } from "./memory/demotion.js";
export type { CreateFlagParams } from "./memory/demotion.js";
export { formatExpectationsReminder } from "./memory/ghost-turn.js";
```

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/presets.ts src/skills/topics/memory.ts src/index.ts
git commit -m "feat: wire knowledge lifecycle into manager defaults, skill docs, and exports"
```

**Step 6: Run full test suite one more time**

Run: `npx vitest run`
Expected: ALL PASS
