/**
 * Per-session memory write tracking and periodic flush management.
 *
 * Tracks whether agents are writing to memory during their sessions
 * and triggers forced memory flushes when they aren't.
 */

type SessionState = {
  turnCount: number;
  memoryWritten: boolean;
  flushAttempted: boolean;
  toolCallCount: number;
};

const sessions = new Map<string, SessionState>();

function getOrCreate(sessionKey: string): SessionState {
  let state = sessions.get(sessionKey);
  if (!state) {
    state = { turnCount: 0, memoryWritten: false, flushAttempted: false, toolCallCount: 0 };
    sessions.set(sessionKey, state);
  }
  return state;
}

// ── Turn counting ──

export function incrementTurnCount(sessionKey: string): number {
  const state = getOrCreate(sessionKey);
  state.turnCount++;
  return state.turnCount;
}

export function getTurnCount(sessionKey: string): number {
  return sessions.get(sessionKey)?.turnCount ?? 0;
}

export function incrementToolCallCount(sessionKey: string): void {
  getOrCreate(sessionKey).toolCallCount++;
}

// ── Memory write tracking ──

export function markMemoryWrite(sessionKey: string): void {
  getOrCreate(sessionKey).memoryWritten = true;
}

export function hasMemoryWrite(sessionKey: string): boolean {
  return sessions.get(sessionKey)?.memoryWritten ?? false;
}

// ── Periodic flush ──

/**
 * Check if a periodic flush should be triggered.
 * Returns true when turn count has reached the flush interval
 * AND no memory writes have been detected in the current cycle.
 */
export function shouldFlush(sessionKey: string, flushInterval: number): boolean {
  const state = sessions.get(sessionKey);
  if (!state) return false;
  return state.turnCount > 0
    && state.turnCount % flushInterval === 0
    && !state.memoryWritten;
}

/**
 * Reset the cycle after a flush or memory write.
 * Keeps the session alive but resets write tracking.
 */
export function resetCycle(sessionKey: string): void {
  const state = sessions.get(sessionKey);
  if (state) {
    state.memoryWritten = false;
  }
}

// ── Session-end safety net ──

export function markFlushAttempted(sessionKey: string): void {
  getOrCreate(sessionKey).flushAttempted = true;
}

export function hasFlushBeenAttempted(sessionKey: string): boolean {
  return sessions.get(sessionKey)?.flushAttempted ?? false;
}

/**
 * Check if a session had enough activity to warrant a memory flush.
 */
export function isSessionSubstantive(sessionKey: string, minToolCalls: number): boolean {
  const state = sessions.get(sessionKey);
  if (!state) return false;
  return state.toolCallCount >= minToolCalls;
}

// ── Cleanup ──

export function clearSession(sessionKey: string): void {
  sessions.delete(sessionKey);
}

/** For testing only. */
export function clearAllSessions(): void {
  sessions.clear();
}

// ── Memory write detection ──

const WRITE_TOOLS = new Set(["edit_file", "write_file", "create_file", "write_to_file"]);
const WRITE_ACTIONS = new Set(["save", "write", "create", "update", "store", "append"]);

/**
 * Heuristic: detect if a tool call represents a memory write.
 *
 * Checks for:
 * - File-write tools targeting memory/ paths
 * - Any tool with "memory" in the name + write-like action
 */
export function isMemoryWriteCall(toolName: string, params: unknown): boolean {
  // File-write tools targeting memory directories
  if (WRITE_TOOLS.has(toolName)) {
    const p = params as Record<string, unknown> | null | undefined;
    if (p) {
      const filePath = String(p.path ?? p.file_path ?? p.filename ?? "");
      if (filePath.includes("memory/") || filePath.includes(".memory/")) {
        return true;
      }
    }
  }

  // Any tool with "memory" in the name and a write-like action
  if (toolName.includes("memory")) {
    const p = params as Record<string, unknown> | null | undefined;
    const action = String(p?.action ?? "");
    if (WRITE_ACTIONS.has(action)) return true;
  }

  return false;
}

// ── Flush prompt ──

const FLUSH_PROMPT = `## Memory Checkpoint

Take a moment to save important context from this session to memory.

Review the recent conversation and save:
- Key decisions made and their rationale
- User preferences or corrections you observed
- Important context that would help in future sessions
- Patterns, contacts, or project details worth remembering

Use memory_search first to check for existing memories, then save new or updated learnings. Be selective — only save what would genuinely help in future conversations.`;

export function getFlushPrompt(): string {
  return FLUSH_PROMPT;
}
