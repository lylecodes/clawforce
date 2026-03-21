/**
 * ClawForce — Claude Code Hook Installer
 *
 * Installs ClawForce governance hooks into Claude Code's settings.json.
 * Non-destructive: reads existing settings, adds/updates ClawForce hook entries,
 * and preserves all existing hooks from other sources.
 *
 * Usage:
 *   import { installHooks } from './install-hooks.js';
 *   const result = installHooks();
 *   console.log(result.installed, result.skipped);
 *
 * Or run directly:
 *   npx tsx adapters/claude-code/install-hooks.ts
 */

import fs from "node:fs";
import path from "node:path";

type HookEntry = {
  type: string;
  command: string;
};

type EventHookGroup = {
  matcher?: string;
  hooks: HookEntry[];
};

export function installHooks(options?: {
  settingsPath?: string;
  hooksDir?: string;
  configDir?: string;
}): { installed: string[]; skipped: string[] } {
  const configDir = options?.configDir || path.join(process.env.HOME!, ".claude");
  const settingsPath = options?.settingsPath || path.join(configDir, "settings.json");
  const hooksDir = options?.hooksDir || path.resolve(import.meta.dirname, "hooks");

  // Read existing settings
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    // File doesn't exist or invalid — start fresh
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  const hookDefs = [
    { event: "SessionStart", script: "session-start.mjs" },
    { event: "PreToolUse", script: "pre-tool-use.mjs" },
    { event: "PostToolUse", script: "post-tool-use.mjs" },
    { event: "Stop", script: "stop.mjs" },
  ];

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const def of hookDefs) {
    const command = `node ${path.join(hooksDir, def.script)}`;

    if (!hooks[def.event]) hooks[def.event] = [];
    const eventHooks = hooks[def.event] as EventHookGroup[];

    // Check if ClawForce hooks are already installed for this event
    const alreadyInstalled = eventHooks.some((h) =>
      h.hooks?.some((hh) => hh.command?.includes("clawforce")),
    );

    if (alreadyInstalled) {
      skipped.push(def.event);
      continue;
    }

    eventHooks.push({
      hooks: [{ type: "command", command }],
    });
    installed.push(def.event);
  }

  // Write back settings
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  return { installed, skipped };
}

export function uninstallHooks(options?: {
  settingsPath?: string;
  configDir?: string;
}): { removed: string[] } {
  const configDir = options?.configDir || path.join(process.env.HOME!, ".claude");
  const settingsPath = options?.settingsPath || path.join(configDir, "settings.json");

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return { removed: [] };
  }

  if (!settings.hooks) return { removed: [] };
  const hooks = settings.hooks as Record<string, unknown[]>;
  const removed: string[] = [];

  for (const [event, eventHooks] of Object.entries(hooks)) {
    if (!Array.isArray(eventHooks)) continue;
    const filtered = eventHooks.filter((h: unknown) => {
      const group = h as EventHookGroup;
      return !group.hooks?.some((hh) => hh.command?.includes("clawforce"));
    });
    if (filtered.length < eventHooks.length) {
      hooks[event] = filtered;
      removed.push(event);
    }
  }

  if (removed.length > 0) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  return { removed };
}

// --- CLI entry point ---
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("install-hooks.ts")) {
  const action = process.argv[2] || "install";

  if (action === "uninstall") {
    const result = uninstallHooks();
    if (result.removed.length > 0) {
      console.log(`Removed ClawForce hooks: ${result.removed.join(", ")}`);
    } else {
      console.log("No ClawForce hooks found to remove.");
    }
  } else {
    const configDir = process.argv[3] || undefined;
    const result = installHooks({ configDir });
    if (result.installed.length > 0) {
      console.log(`Installed ClawForce hooks: ${result.installed.join(", ")}`);
    }
    if (result.skipped.length > 0) {
      console.log(`Already installed (skipped): ${result.skipped.join(", ")}`);
    }
    if (result.installed.length === 0 && result.skipped.length === 0) {
      console.log("No hooks configured.");
    }
  }
}
