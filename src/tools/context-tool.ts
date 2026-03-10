/**
 * Clawforce — Context tool
 *
 * Mid-session context retrieval for agents.
 * Actions: get_file, list_skills, get_skill, get_knowledge.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { getDb } from "../db.js";
import { getAgentConfig } from "../project.js";
import { getTopicList, resolveSkillSource } from "../skills/registry.js";
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readStringParam, readStringArrayParam, readNumberParam, resolveProjectId, safeExecute } from "./common.js";

const CONTEXT_ACTIONS = ["get_file", "list_skills", "get_skill", "get_knowledge"] as const;

const ClawforceContextSchema = Type.Object({
  action: stringEnum(CONTEXT_ACTIONS, { description: "Action to perform." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier." })),
  path: Type.Optional(Type.String({ description: "File path relative to project directory (for get_file)." })),
  topic: Type.Optional(Type.String({ description: "Skill topic ID (for get_skill)." })),
  category: Type.Optional(Type.Array(Type.String(), { description: "Knowledge category filter (for get_knowledge)." })),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Knowledge tags filter (for get_knowledge)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (for get_knowledge, default 20)." })),
});

export function createClawforceContextTool(options?: {
  agentSessionKey?: string;
  projectId?: string;
  projectDir?: string;
}) {
  return {
    label: "Context Retrieval",
    name: "clawforce_context",
    description:
      "Retrieve context mid-session. " +
      "get_file: Read a project file. " +
      "list_skills: List available skill topics. " +
      "get_skill: Get full content for a skill topic. " +
      "get_knowledge: Query knowledge base with category/tags filters.",
    parameters: ClawforceContextSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const resolved = resolveProjectId(params, options?.projectId);
        if (resolved.error) return jsonResult({ ok: false, reason: resolved.error });
        const projectId = resolved.projectId!;
        const actor = options?.agentSessionKey ?? "unknown";
        const agentEntry = getAgentConfig(actor);
        const role = agentEntry?.config.extends ?? "employee";
        const projectDir = options?.projectDir ?? agentEntry?.projectDir;

        switch (action) {
          case "get_file": {
            const filePath = readStringParam(params, "path", { required: true })!;
            if (!projectDir) {
              return jsonResult({ ok: false, reason: "No project directory configured." });
            }

            // Path traversal guard
            const resolvedPath = path.resolve(projectDir, filePath);
            if (!resolvedPath.startsWith(projectDir + path.sep) && resolvedPath !== projectDir) {
              return jsonResult({ ok: false, reason: "Path traversal not allowed." });
            }

            try {
              if (!fs.existsSync(resolvedPath)) {
                return jsonResult({ ok: false, reason: `File not found: ${filePath}` });
              }
              const content = fs.readFileSync(resolvedPath, "utf-8");
              // 10KB cap
              const capped = content.length > 10_240
                ? content.slice(0, 10_240) + "\n…(truncated)"
                : content;
              return jsonResult({ ok: true, path: filePath, content: capped, truncated: content.length > 10_240 });
            } catch (err) {
              return jsonResult({ ok: false, reason: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` });
            }
          }

          case "list_skills": {
            const topics = getTopicList(role, projectId);
            return jsonResult({ ok: true, topics, count: topics.length });
          }

          case "get_skill": {
            const topic = readStringParam(params, "topic", { required: true })!;
            const content = resolveSkillSource(role, topic, undefined, projectId);
            if (content === null) {
              return jsonResult({ ok: false, reason: `Unknown topic: "${topic}"` });
            }
            return jsonResult({ ok: true, topic, content });
          }

          case "get_knowledge": {
            const categories = readStringArrayParam(params, "category");
            const tags = readStringArrayParam(params, "tags");
            const limit = readNumberParam(params, "limit", { integer: true }) ?? 20;

            try {
              const db = getDb(projectId);

              let query = "SELECT id, title, category, content, tags FROM knowledge WHERE project_id = ?";
              const queryParams: (string | number | null)[] = [projectId];

              if (categories && categories.length > 0) {
                const placeholders = categories.map(() => "?").join(", ");
                query += ` AND category IN (${placeholders})`;
                queryParams.push(...categories);
              }

              if (tags && tags.length > 0) {
                for (const tag of tags) {
                  query += " AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)";
                  queryParams.push(tag);
                }
              }

              query += " ORDER BY created_at DESC LIMIT ?";
              queryParams.push(limit);

              const rows = db.prepare(query).all(...queryParams) as Record<string, unknown>[];
              const entries = rows.map((r) => ({
                id: r.id,
                title: r.title,
                category: r.category,
                content: String(r.content).slice(0, 2048),
                tags: r.tags ? JSON.parse(r.tags as string) : [],
              }));

              return jsonResult({ ok: true, entries, count: entries.length });
            } catch (err) {
              return jsonResult({ ok: false, reason: `Knowledge query failed: ${err instanceof Error ? err.message : String(err)}` });
            }
          }

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}
