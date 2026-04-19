import { dispatchViaCodexExecutor } from "../../adapters/codex/executor.js";
import { dispatchViaClaudeExecutor } from "../../adapters/claude-code/executor.js";
import { dispatchViaInject } from "./inject-dispatch.js";
import { resolveOpenClawAgentId } from "../project.js";
import {
  getDispatchExecutorPort,
} from "../runtime/integrations.js";
import type {
  DispatchExecutionRequestPort,
  DispatchExecutionResultPort,
  DispatchExecutorPort,
} from "../runtime/ports.js";
import type { DispatchExecutorName } from "../types.js";
import { assessAgentRuntimeScope, resolveConfiguredDispatchExecutorName } from "./runtime-scope.js";

const BUILTIN_EXECUTORS: Record<DispatchExecutorName, DispatchExecutorPort> = {
  openclaw: {
    id: "openclaw",
    async dispatch(request: DispatchExecutionRequestPort): Promise<DispatchExecutionResultPort> {
      const dispatchAgentId = resolveOpenClawAgentId(request.agentId, request.projectId);
      const result = await dispatchViaInject({
        ...request,
        agentId: dispatchAgentId,
      });
      return {
        executor: "openclaw",
        ...result,
      };
    },
  },
  codex: {
    id: "codex",
    dispatch: dispatchViaCodexExecutor,
  },
  "claude-code": {
    id: "claude-code",
    dispatch: dispatchViaClaudeExecutor,
  },
};

export function resolveDispatchExecutorName(
  projectId: string,
  agentId?: string,
  agentConfig?: DispatchExecutionRequestPort["agentConfig"],
): DispatchExecutorName {
  if (!agentId) {
    return resolveConfiguredDispatchExecutorName(projectId);
  }
  return assessAgentRuntimeScope(projectId, agentId, agentConfig).executor;
}

export function getDispatchExecutor(
  projectId: string,
  agentId?: string,
  agentConfig?: DispatchExecutionRequestPort["agentConfig"],
): DispatchExecutorPort {
  const executorName = resolveDispatchExecutorName(projectId, agentId, agentConfig);
  return getDispatchExecutorPort(executorName)
    ?? BUILTIN_EXECUTORS[executorName];
}

export async function executeDispatch(
  request: DispatchExecutionRequestPort,
): Promise<DispatchExecutionResultPort> {
  return getDispatchExecutor(request.projectId, request.agentId, request.agentConfig).dispatch(request);
}
