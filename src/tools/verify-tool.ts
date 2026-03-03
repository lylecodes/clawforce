/**
 * Clawforce — Verify tool
 *
 * Dispatches verifiers and submits verdicts for task verification.
 * Actions: request (dispatch verifier), verdict (submit PASS/FAIL).
 */

import { Type } from "@sinclair/typebox";
import { requestVerification, submitVerdict } from "../tasks/verify.js";
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { errorResult, jsonResult, readBooleanParam, readStringParam, safeExecute } from "./common.js";

const VERIFY_ACTIONS = ["request", "verdict"] as const;

const ClawforceVerifySchema = Type.Object({
  action: stringEnum(VERIFY_ACTIONS, { description: "Action: request (dispatch verifier) or verdict (submit PASS/FAIL)." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier (defaults to 'default')." })),
  task_id: Type.String({ description: "Task ID to verify." }),
  project_dir: Type.Optional(Type.String({ description: "Project directory (for request, defaults to cwd)." })),
  profile: Type.Optional(Type.String({ description: "Verifier agent profile (for request)." })),
  model: Type.Optional(Type.String({ description: "Verifier model override (for request)." })),
  prompt: Type.Optional(Type.String({ description: "Custom verification prompt (for request)." })),
  passed: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "Verdict: true/\"true\" for PASS, false/\"false\" for FAIL (for verdict)." })),
  reason: Type.Optional(Type.String({ description: "Reason for the verdict (for verdict)." })),
});

export function createClawforceVerifyTool(options?: {
  agentSessionKey?: string;
}) {
  return {
    label: "Work Review",
    name: "clawforce_verify",
    description:
      "Review task output via cross-team verification. " +
      "request — Dispatch a reviewer (task must be in REVIEW). " +
      "verdict — Submit PASS/FAIL with reason.",
    parameters: ClawforceVerifySchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const projectId = readStringParam(params, "project_id") ?? "default";
        const taskId = readStringParam(params, "task_id", { required: true })!;
        const actor = options?.agentSessionKey ?? "unknown";

        switch (action) {
          case "request": {
            const projectDir = readStringParam(params, "project_dir") ?? process.cwd();
            const result = await requestVerification({
              projectId,
              taskId,
              projectDir,
              verifierProfile: readStringParam(params, "profile") ?? undefined,
              verifierModel: readStringParam(params, "model") ?? undefined,
              verificationPrompt: readStringParam(params, "prompt") ?? undefined,
            });
            return jsonResult(result);
          }

          case "verdict": {
            const passedVal = readBooleanParam(params, "passed");
            if (passedVal === null) return errorResult("Missing required parameter: passed");
            const passed = passedVal;
            const reason = readStringParam(params, "reason") ?? undefined;
            const result = submitVerdict({
              projectId,
              taskId,
              verifier: actor,
              passed,
              reason,
            });
            return jsonResult(result);
          }

          default:
            return errorResult(`Unknown action: ${action}`);
        }
      });
    },
  };
}
