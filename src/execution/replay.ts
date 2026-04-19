import { execSync } from "node:child_process";
import type { DatabaseSync } from "../sqlite-driver.js";
import { getProjectDir } from "../project.js";
import type { SimulatedAction } from "../types.js";
import {
  getSimulatedAction,
  setSimulatedActionStatus,
} from "./simulated-actions.js";

export type SimulatedActionReplayResult = {
  ok: boolean;
  mode: "command";
  simulatedAction: SimulatedAction;
  output?: unknown;
  error?: string;
};

export function replaySimulatedCommand(
  projectId: string,
  actionId: string,
  dbOverride?: DatabaseSync,
): SimulatedActionReplayResult {
  const simulatedAction = getSimulatedAction(projectId, actionId, dbOverride);
  if (!simulatedAction) {
    throw new Error(`Simulated action not found: ${actionId}`);
  }

  const payload = simulatedAction.payload ?? {};
  const command = typeof payload.command === "string"
    ? payload.command
    : simulatedAction.targetType === "command" && simulatedAction.targetId
      ? simulatedAction.targetId
      : undefined;
  if (!command) {
    throw new Error(`Simulated action ${actionId} does not include a replayable command.`);
  }

  const workingDir = typeof payload.workingDir === "string"
    ? payload.workingDir
    : getProjectDir(projectId) ?? process.cwd();

  try {
    const stdout = execSync(command, {
      cwd: workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
    });
    setSimulatedActionStatus(projectId, actionId, "approved_for_live", dbOverride);
    return {
      ok: true,
      mode: "command",
      simulatedAction,
      output: { stdout },
    };
  } catch (err) {
    const record = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      mode: "command",
      simulatedAction,
      output: { stdout: record.stdout, stderr: record.stderr },
      error: record.message ?? "Command replay failed",
    };
  }
}
