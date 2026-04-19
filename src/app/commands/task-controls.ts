import { attachEvidence, createTask, reassignTask, transitionTask } from "../../tasks/ops.js";
import type { EvidenceType, TaskPriority, TaskState } from "../../types.js";

export type TaskCommandResult = {
  status: number;
  body: unknown;
  sse?: {
    event: "task:update";
    payload: Record<string, unknown>;
  };
};

export function runCreateTaskCommand(
  projectId: string,
  body: Record<string, unknown>,
): TaskCommandResult {
  const title = typeof body.title === "string" ? body.title : "";
  if (!title) {
    return { status: 400, body: { error: "title is required" } };
  }

  const task = createTask({
    projectId,
    title,
    description: body.description as string | undefined,
    priority: body.priority as TaskPriority | undefined,
    assignedTo: body.assignedTo as string | undefined,
    createdBy: (body.createdBy as string) ?? "dashboard",
    deadline: body.deadline as number | undefined,
    tags: body.tags as string[] | undefined,
    department: body.department as string | undefined,
    team: body.team as string | undefined,
    goalId: body.goalId as string | undefined,
  });

  return {
    status: 201,
    body: task,
    sse: {
      event: "task:update",
      payload: { taskId: task.id, action: "created" },
    },
  };
}

export function runReassignTaskCommand(
  projectId: string,
  taskId: string,
  body: Record<string, unknown>,
): TaskCommandResult {
  const newAssignee = typeof body.newAssignee === "string" ? body.newAssignee : "";
  if (!newAssignee) {
    return { status: 400, body: { error: "newAssignee is required" } };
  }

  const result = reassignTask({
    projectId,
    taskId,
    newAssignee,
    actor: (body.actor as string) ?? "dashboard",
    reason: body.reason as string | undefined,
  });
  if (!result.ok) {
    return { status: 400, body: { error: result.reason } };
  }

  return {
    status: 200,
    body: result,
    sse: {
      event: "task:update",
      payload: { taskId, action: "reassigned", newAssignee },
    },
  };
}

export function runTransitionTaskCommand(
  projectId: string,
  taskId: string,
  body: Record<string, unknown>,
): TaskCommandResult {
  const toState = body.toState as TaskState | undefined;
  if (!toState) {
    return { status: 400, body: { error: "toState is required" } };
  }

  const result = transitionTask({
    projectId,
    taskId,
    toState,
    actor: (body.actor as string) ?? "dashboard",
    reason: body.reason as string | undefined,
  });
  if (!result.ok) {
    return { status: 400, body: { error: result.reason } };
  }

  return {
    status: 200,
    body: result,
    sse: {
      event: "task:update",
      payload: { taskId, action: "transitioned", toState },
    },
  };
}

export function runAttachTaskEvidenceCommand(
  projectId: string,
  taskId: string,
  body: Record<string, unknown>,
): TaskCommandResult {
  const content = typeof body.content === "string" ? body.content : "";
  if (!content) {
    return { status: 400, body: { error: "content is required" } };
  }

  const evidence = attachEvidence({
    projectId,
    taskId,
    type: (body.type as EvidenceType) ?? "custom",
    content,
    attachedBy: (body.attachedBy as string) ?? "dashboard",
    metadata: body.metadata as Record<string, unknown> | undefined,
  });

  return {
    status: 201,
    body: {
      ok: true,
      evidence: {
        id: evidence.id,
        content: evidence.content,
        type: evidence.type,
      },
    },
    sse: {
      event: "task:update",
      payload: {
        taskId,
        action: "evidence_attached",
        evidenceId: evidence.id,
      },
    },
  };
}
