/**
 * Clawforce — Flush Prompt Generation
 *
 * Per-agent flush prompts for memory checkpoint turns.
 * Timing delegated to OpenClaw's native memoryFlush (softThresholdTokens).
 * This module only generates the prompt content and detects memory writes.
 */

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

export function getFlushPrompt(fileTargets?: string[]): string {
  if (!fileTargets || fileTargets.length === 0) return FLUSH_PROMPT;

  const fileSection = fileTargets
    .map((f) => `- ${f}`)
    .join("\n");

  return `${FLUSH_PROMPT}\n\nAlso update these files with relevant learnings:\n${fileSection}`;
}
