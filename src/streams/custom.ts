/**
 * Clawforce — Custom Computed Streams
 *
 * Executes user-defined SQL queries against a read-only DB connection.
 * Results formatted as table, JSON, or summary for briefing/webhook use.
 */

import { DatabaseSync, type SQLInputValue } from "../sqlite-driver.js";

export type CustomStreamDef = {
  name: string;
  query: string;
  format: "table" | "json" | "summary";
  description?: string;
};

export type StreamResult = {
  text: string;
  rows: Record<string, unknown>[];
  json?: Record<string, unknown>[];
};

const DEFAULT_LIMIT = 10000;

export function executeCustomStream(
  dbPath: string,
  streamDef: CustomStreamDef,
  params?: Record<string, unknown>,
): StreamResult {
  // Open a read-only connection — kernel-level enforcement
  const db = new DatabaseSync(dbPath, { readOnly: true });

  try {
    let query = streamDef.query.trim();

    // Append LIMIT if none present
    if (!/\bLIMIT\b/i.test(query)) {
      // Remove trailing semicolon if present
      if (query.endsWith(";")) query = query.slice(0, -1);
      query = `${query} LIMIT ${DEFAULT_LIMIT}`;
    }

    // Build bindings array from params
    const bindings: SQLInputValue[] = [];
    if (params) {
      // Support positional params (keys are "1", "2", etc.)
      const keys = Object.keys(params).sort((a, b) => Number(a) - Number(b));
      for (const key of keys) {
        bindings.push(params[key] as SQLInputValue);
      }
    }

    const stmt = db.prepare(query);
    const rows = (bindings.length > 0 ? stmt.all(...bindings) : stmt.all()) as Record<string, unknown>[];

    return {
      text: formatResult(streamDef.name, rows, streamDef.format),
      rows,
      json: streamDef.format === "json" ? rows : undefined,
    };
  } finally {
    db.close();
  }
}

function formatResult(
  name: string,
  rows: Record<string, unknown>[],
  format: "table" | "json" | "summary",
): string {
  if (rows.length === 0) return `## ${name}\n\nNo results.`;

  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2);

    case "summary":
      return `## ${name}\n\n${rows.length} result(s).`;

    case "table": {
      const columns = Object.keys(rows[0]);
      const header = `| ${columns.join(" | ")} |`;
      const separator = `| ${columns.map(() => "---").join(" | ")} |`;
      const body = rows
        .slice(0, 100) // Cap table display at 100 rows
        .map((row) => `| ${columns.map((c) => String(row[c] ?? "")).join(" | ")} |`)
        .join("\n");

      const truncated = rows.length > 100 ? `\n\n...and ${rows.length - 100} more rows.` : "";
      return `## ${name}\n\n${header}\n${separator}\n${body}${truncated}`;
    }
  }
}
