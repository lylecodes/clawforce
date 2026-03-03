/**
 * Clawforce — Workflow tool
 *
 * Manages phased workflows: create, get, list, add_task, advance, phase_status.
 */

import { Type } from "@sinclair/typebox";
import {
  addTaskToPhase,
  advanceWorkflow,
  createWorkflow,
  forceAdvanceWorkflow,
  getPhaseStatus,
  getWorkflow,
  listWorkflows,
} from "../workflow.js";
import { stringEnum } from "../schema-helpers.js";
import type { ToolResult } from "./common.js";
import { errorResult, jsonResult, readNumberParam, readStringParam, safeExecute } from "./common.js";

const WORKFLOW_ACTIONS = [
  "create", "get", "list", "add_task", "advance", "force_advance", "phase_status",
] as const;

const ClawforceWorkflowSchema = Type.Object({
  action: stringEnum(WORKFLOW_ACTIONS, { description: "Action to perform on the workflow system." }),
  project_id: Type.String({ description: "Project identifier." }),
  workflow_id: Type.Optional(Type.String({ description: "Workflow ID (for get/add_task/advance/phase_status)." })),
  name: Type.Optional(Type.String({ description: "Workflow name (for create)." })),
  phases: Type.Optional(Type.Array(
    Type.Object({
      name: Type.String({ description: "Phase name." }),
      description: Type.Optional(Type.String({ description: "Phase description." })),
      gate_condition: Type.Optional(Type.String({ description: "Gate: all_done (default), any_done, all_resolved, or any_resolved." })),
    }),
    { description: "Phase definitions (for create)." },
  )),
  phase: Type.Optional(Type.Number({ description: "Phase index (for add_task/phase_status)." })),
  task_id: Type.Optional(Type.String({ description: "Task ID to add to phase (for add_task)." })),
});

export function createClawforceWorkflowTool(options?: {
  agentSessionKey?: string;
}) {
  return {
    label: "Process Management",
    name: "clawforce_workflow",
    description:
      "Manage phased work processes. " +
      "Setup: create, get, list. " +
      "Execution: add_task, advance, phase_status. " +
      "Create multi-phase execution plans, add tasks to phases, check phase status, and advance when gates are satisfied.",
    parameters: ClawforceWorkflowSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const projectId = readStringParam(params, "project_id", { required: true })!;
        const actor = options?.agentSessionKey ?? "unknown";

        switch (action) {
          case "create": {
            const name = readStringParam(params, "name", { required: true })!;
            const rawPhases = params.phases;
            if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
              return errorResult("phases array is required for create");
            }
            const validGates = ["all_done", "any_done", "all_resolved", "any_resolved"] as const;
            type GateCondition = (typeof validGates)[number];
            const phases = rawPhases.map((p: Record<string, unknown>) => {
              const raw = p.gate_condition as string | undefined;
              const gateCondition: GateCondition = raw && (validGates as readonly string[]).includes(raw)
                ? (raw as GateCondition)
                : "all_done";
              return {
                name: String(p.name ?? "Unnamed"),
                description: p.description ? String(p.description) : undefined,
                gateCondition,
              };
            });
            const workflow = createWorkflow({ projectId, name, phases, createdBy: actor });
            return jsonResult({ ok: true, workflow });
          }

          case "get": {
            const workflowId = readStringParam(params, "workflow_id", { required: true })!;
            const workflow = getWorkflow(projectId, workflowId);
            if (!workflow) return errorResult("Workflow not found");
            return jsonResult({ ok: true, workflow });
          }

          case "list": {
            const workflows = listWorkflows(projectId);
            return jsonResult({ ok: true, workflows });
          }

          case "add_task": {
            const workflowId = readStringParam(params, "workflow_id", { required: true })!;
            const phase = readNumberParam(params, "phase", { integer: true });
            const taskId = readStringParam(params, "task_id", { required: true })!;
            if (phase === null) return errorResult("phase is required for add_task");
            const ok = addTaskToPhase({ projectId, workflowId, phase, taskId });
            return jsonResult({ ok });
          }

          case "advance": {
            const workflowId = readStringParam(params, "workflow_id", { required: true })!;
            const newPhase = advanceWorkflow(projectId, workflowId);
            if (newPhase === null) return errorResult("Gate not satisfied or workflow not active");
            return jsonResult({ ok: true, advanced: true, currentPhase: newPhase });
          }

          case "force_advance": {
            const workflowId = readStringParam(params, "workflow_id", { required: true })!;
            const newPhase = forceAdvanceWorkflow(projectId, workflowId, actor);
            if (newPhase === null) return errorResult("Workflow not found or not active");
            return jsonResult({ ok: true, forced: true, currentPhase: newPhase });
          }

          case "phase_status": {
            const workflowId = readStringParam(params, "workflow_id", { required: true })!;
            const phase = readNumberParam(params, "phase", { integer: true });
            if (phase === null) return errorResult("phase is required for phase_status");
            const status = getPhaseStatus(projectId, workflowId, phase);
            if (!status) return errorResult("Phase not found");
            return jsonResult({ ok: true, ...status });
          }

          default:
            return errorResult(`Unknown action: ${action}`);
        }
      });
    },
  };
}
