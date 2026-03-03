/**
 * Clawforce — Compact tool
 *
 * Scoped file read/write tool for session compaction.
 * Agents use this to update their context documents with session learnings.
 * All operations are confined to the project directory with path traversal protection.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { emitDiagnosticEvent, safeLog } from "../diagnostics.js";
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { errorResult, jsonResult, readStringParam, safeExecute } from "./common.js";

const COMPACT_ACTIONS = ["update_doc", "read_doc"] as const;

/** Max file size for read_doc (10KB, matching assembler's resolveFile cap). */
const MAX_READ_BYTES = 10_240;

const ClawforceCompactSchema = Type.Object({
  action: stringEnum(COMPACT_ACTIONS, { description: "Action to perform: update_doc (write updates to a file) or read_doc (read a file before updating)." }),
  file_path: Type.String({ description: "File path relative to the project directory." }),
  content: Type.Optional(Type.String({ description: "Full updated file content (for update_doc). Provide the complete file, not just a diff." })),
});

export function createClawforceCompactTool(options: {
  projectDir: string;
  agentSessionKey?: string;
  agentId?: string;
}) {
  return {
    label: "Knowledge Update",
    name: "clawforce_compact",
    description:
      "Update or read project documents for knowledge persistence. " +
      "Use update_doc to write updated content to a project file. " +
      "Use read_doc to read a file before updating it. " +
      "All paths are relative to the project directory.",
    parameters: ClawforceCompactSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const filePath = readStringParam(params, "file_path", { required: true })!;

        // Path traversal protection: resolved path must be under projectDir
        const resolved = path.resolve(options.projectDir, filePath);
        if (!resolved.startsWith(options.projectDir + path.sep) && resolved !== options.projectDir) {
          return errorResult(`Path "${filePath}" resolves outside the project directory.`);
        }

        switch (action) {
          case "update_doc":
            return handleUpdateDoc(resolved, filePath, params, options);
          case "read_doc":
            return handleReadDoc(resolved, filePath);
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      });
    },
  };
}

function handleUpdateDoc(
  resolved: string,
  filePath: string,
  params: Record<string, unknown>,
  options: { projectDir: string; agentSessionKey?: string; agentId?: string },
): ToolResult {
  const content = readStringParam(params, "content", { required: true })!;

  // Read previous content for size comparison
  let previousSize = 0;
  try {
    const stat = fs.statSync(resolved);
    previousSize = stat.size;
  } catch {
    // File doesn't exist yet — that's fine
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(resolved);
  fs.mkdirSync(parentDir, { recursive: true });

  // Write the updated content
  fs.writeFileSync(resolved, content, "utf-8");

  const newSize = Buffer.byteLength(content, "utf-8");
  const actor = options.agentId ?? options.agentSessionKey ?? "unknown";

  // Audit trail via diagnostic event
  try {
    emitDiagnosticEvent({
      type: "compaction_update",
      agentId: actor,
      filePath,
      previousSize,
      newSize,
    });
  } catch (err) {
    safeLog("compact.updateDoc.diagnostic", err);
  }

  return jsonResult({
    ok: true,
    file_path: filePath,
    previous_size: previousSize,
    new_size: newSize,
  });
}

function handleReadDoc(resolved: string, filePath: string): ToolResult {
  try {
    if (!fs.existsSync(resolved)) {
      return jsonResult({
        ok: true,
        file_path: filePath,
        exists: false,
        content: null,
      });
    }

    const content = fs.readFileSync(resolved, "utf-8");
    const capped = content.length > MAX_READ_BYTES
      ? content.slice(0, MAX_READ_BYTES) + "\n…(truncated)"
      : content;

    return jsonResult({
      ok: true,
      file_path: filePath,
      exists: true,
      size: Buffer.byteLength(content, "utf-8"),
      content: capped,
    });
  } catch (err) {
    return errorResult(`Failed to read "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
