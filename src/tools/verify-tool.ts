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
import { errorResult, jsonResult, readBooleanParam, readStringParam, resolveProjectId, safeExecute } from "./common.js";

const VERIFY_ACTIONS = ["request", "verdict"] as const;

const ClawforceVerifySchema = Type.Object({
  action: stringEnum(VERIFY_ACTIONS, { description: "Action: request (dispatch verifier) or verdict (submit PASS/FAIL)." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier (defaults to 'default')." })),
  task_id: Type.String({ description: "Task ID to verify." }),
  project_dir: Type.Optional(Type.String({ description: "Project directory (for request, defaults to cwd)." })),
  agent_id: Type.Optional(Type.String({ description: "Verifier agent ID to dispatch for a REVIEW task (for request)." })),
  profile: Type.Optional(Type.String({ description: "Verifier agent profile (for request)." })),
  model: Type.Optional(Type.String({ description: "Verifier model override (for request)." })),
  prompt: Type.Optional(Type.String({ description: "Custom verification prompt (for request)." })),
  passed: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "Verdict: true/\"true\" for PASS, false/\"false\" for FAIL (for verdict)." })),
  reason_code: Type.Optional(Type.String({ description: "Structured review reason code for failed verdicts (for verdict)." })),
  reason: Type.Optional(Type.String({ description: "Reason for the verdict (for verdict)." })),
});

export function createClawforceVerifyTool(options?: {
  agentSessionKey?: string;
  projectId?: string;
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
        const resolved = resolveProjectId(params, options?.projectId);
        if (resolved.error) return jsonResult({ ok: false, reason: resolved.error });
        const projectId = resolved.projectId!;
        const taskId = readStringParam(params, "task_id", { required: true })!;
        const actor = options?.agentSessionKey ?? "unknown";

        switch (action) {
          case "request": {
            const projectDir = readStringParam(params, "project_dir") ?? process.cwd();
            const result = requestVerification({
              projectId,
              taskId,
              projectDir,
              verifierAgentId: readStringParam(params, "agent_id") ?? undefined,
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
              reasonCode: readStringParam(params, "reason_code") as import("../types.js").ReviewReasonCode | undefined,
              reason,
              sessionKey: options?.agentSessionKey,
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
