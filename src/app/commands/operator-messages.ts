import { emitSSE } from "../../dashboard/sse.js";
import { ingestEvent } from "../../events/store.js";
import { createMessage, markDelivered } from "../../messaging/store.js";
import { getDb } from "../../db.js";
import type { MessageContextRefs } from "../../api/contract.js";
import type { Message, MessagePriority } from "../../types.js";
import {
  getDashboardAssistantSettings,
  parseAssistantDirective,
  renderAssistantLiveDeliveryMessage,
  renderAssistantStoredMessage,
  renderAssistantUnavailableMessage,
  resolveAssistantFallbackTarget,
} from "../queries/dashboard-assistant.js";

export type InjectAgentMessage = (params: {
  sessionKey: string;
  message: string;
}) => Promise<{ runId?: string }>;

type CommandError = {
  ok: false;
  status: number;
  error: string;
};

export type SendDirectMessageCommandResult =
  | {
      ok: true;
      status: 201;
      message: Message;
    }
  | CommandError;

export type DeliverOperatorMessageCommandResult =
  | {
      ok: true;
      status: 200;
      delivery: "live" | "stored" | "unavailable";
      acknowledgement: string;
      message?: Message;
    }
  | CommandError;

export function runSendDirectMessageCommand(
  projectId: string,
  input: {
    toAgent?: string;
    content?: string;
    priority?: MessagePriority;
    proposalId?: string;
    taskId?: string;
    entityId?: string;
    issueId?: string;
  },
): SendDirectMessageCommandResult {
  const toAgent = input.toAgent?.trim();
  const content = input.content?.trim();

  if (!toAgent) {
    return { ok: false, status: 400, error: "to is required" };
  }
  if (!content) {
    return { ok: false, status: 400, error: "content is required" };
  }

  try {
    const metadata = buildMessageContextRefs(input);
    const message = createMessage({
      fromAgent: "user",
      toAgent,
      projectId,
      content,
      type: "direct",
      priority: input.priority ?? "normal",
      metadata,
    });
    emitSSE(projectId, "message:new", {
      toAgent,
      messageId: message.id,
      fromAgent: "user",
    });

    try {
      ingestEvent(projectId, "user_message", "internal", {
        messageId: message.id,
        toAgent,
        content: content.slice(0, 200),
      }, `user-msg:${message.id}`);
    } catch {
      // non-fatal
    }

    return { ok: true, status: 201, message };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDeliverOperatorMessageCommand(
  projectId: string,
  routeAgentId: string,
  body: Record<string, unknown>,
  injectAgentMessage?: InjectAgentMessage,
): Promise<DeliverOperatorMessageCommandResult> {
  const rawContent = typeof body.content === "string"
    ? body.content
    : typeof body.message === "string"
      ? body.message
      : "";
  const isAssistantRoute = routeAgentId === "clawforce-assistant";
  const directive = isAssistantRoute
    ? parseAssistantDirective(rawContent)
    : { content: rawContent };
  const content = directive.content.trim();
  const requestedTarget = typeof body.to === "string"
    ? body.to
    : typeof body.leadId === "string"
      ? body.leadId
      : directive.requestedAgentId;
  const assistantSettings = isAssistantRoute
    ? getDashboardAssistantSettings(projectId)
    : null;
  const assistantTarget = isAssistantRoute
    ? resolveAssistantFallbackTarget(projectId, requestedTarget, assistantSettings ?? undefined)
    : null;

  if (!content) {
    return { ok: false, status: 400, error: "content is required" };
  }

  if (isAssistantRoute && !requestedTarget && assistantSettings && !assistantSettings.enabled) {
    return {
      ok: true,
      status: 200,
      delivery: "unavailable",
      acknowledgement: renderAssistantUnavailableMessage(projectId, assistantSettings),
    };
  }

  const deliveryAgentId = isAssistantRoute
    ? (assistantTarget?.agentId ?? routeAgentId)
    : routeAgentId;

  if (injectAgentMessage) {
    const persisted = persistOperatorMessage(projectId, routeAgentId, body, content, assistantTarget, false);
    if (persisted && !persisted.ok) return persisted;
    const persistedMessage = persisted?.ok ? persisted.message : undefined;

    try {
      await injectAgentMessage({
        sessionKey: `agent:${deliveryAgentId}:main`,
        message: content,
      });
      if (persistedMessage) {
        markDelivered(persistedMessage.id, getDb(projectId));
      }
      return {
        ok: true,
        status: 200,
        delivery: "live",
        acknowledgement: renderAssistantLiveDeliveryMessage(routeAgentId, deliveryAgentId),
        ...(persistedMessage
          ? {
              message: {
                ...persistedMessage,
                status: "delivered",
                deliveredAt: Date.now(),
              },
            }
          : {}),
      };
    } catch (error) {
      if (persisted?.ok) {
        return {
          ok: true,
          status: 200,
          delivery: "stored",
          acknowledgement: `Live delivery failed, but your message was stored for "${deliveryAgentId}". They will see it in their next briefing.`,
          message: persisted.message,
        };
      }
      return {
        ok: false,
        status: 502,
        error: error instanceof Error ? error.message : "Failed to deliver live message",
      };
    }
  }

  const stored = persistOperatorMessage(projectId, routeAgentId, body, content, assistantTarget, false);
  if (stored?.ok) {
    return stored;
  }
  if (stored && !stored.ok) return stored;

  return {
    ok: true,
    status: 200,
    delivery: "unavailable",
    acknowledgement: renderAssistantUnavailableMessage(projectId, assistantSettings ?? undefined),
  };
}

function persistOperatorMessage(
  projectId: string,
  routeAgentId: string,
  body: Record<string, unknown>,
  content: string,
  assistantTarget: ReturnType<typeof resolveAssistantFallbackTarget>,
  afterLiveInjectFailure: boolean,
): DeliverOperatorMessageCommandResult | null {
  if (routeAgentId === "clawforce-assistant") {
    if (!assistantTarget) return null;
    const stored = runSendDirectMessageCommand(projectId, {
      toAgent: assistantTarget.agentId,
      content,
      priority: normalizePriority(body.priority),
      ...buildMessageContextRefs(body),
    });
    if (!stored.ok) return stored;
    return {
      ok: true,
      status: 200,
      delivery: "stored",
      acknowledgement: renderAssistantStoredMessage(assistantTarget),
      message: stored.message,
    };
  }

  const stored = runSendDirectMessageCommand(projectId, {
    toAgent: routeAgentId,
    content,
    priority: normalizePriority(body.priority),
    ...buildMessageContextRefs(body),
  });
  if (!stored.ok) return stored;
  return {
    ok: true,
    status: 200,
    delivery: "stored",
    acknowledgement: afterLiveInjectFailure
      ? `Live delivery failed, but your message was stored for "${routeAgentId}". They will see it in their next briefing.`
      : injectFallbackAcknowledgement(routeAgentId),
    message: stored.message,
  };
}

function normalizePriority(value: unknown): MessagePriority | undefined {
  return value === "high" || value === "urgent" || value === "normal"
    ? value
    : undefined;
}

function normalizeContextRef(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function buildMessageContextRefs(input: Record<string, unknown>): MessageContextRefs | undefined {
  const refs: MessageContextRefs = {
    proposalId: normalizeContextRef(input.proposalId),
    taskId: normalizeContextRef(input.taskId),
    entityId: normalizeContextRef(input.entityId),
    issueId: normalizeContextRef(input.issueId),
  };

  return Object.values(refs).some((value) => typeof value === "string" && value.length > 0)
    ? refs
    : undefined;
}

function injectFallbackAcknowledgement(agentId: string): string {
  return `Stored your message for "${agentId}". They will see it in their next briefing.`;
}
