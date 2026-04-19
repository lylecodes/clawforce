import { concludeMeeting, startMeeting } from "../../channels/meeting.js";
import { sendChannelMessage } from "../../channels/messages.js";
import type { SSEEventType } from "../../dashboard/sse.js";
import { listProjectAgentIds } from "./agent-controls.js";

export type ChannelCommandResult = {
  status: number;
  body: unknown;
  sse?: {
    event: SSEEventType;
    payload: Record<string, unknown>;
  };
};

export function runCreateMeetingCommand(
  projectId: string,
  body: Record<string, unknown>,
): ChannelCommandResult {
  const participants = body.participants;
  if (!Array.isArray(participants) || participants.length === 0) {
    return { status: 400, body: { error: "participants array is required" } };
  }

  const projectAgentIds = listProjectAgentIds(projectId);
  if (projectAgentIds.length > 0) {
    const invalid = participants.filter((participant) => (
      typeof participant !== "string" || !projectAgentIds.includes(participant)
    ));
    if (invalid.length > 0) {
      return {
        status: 400,
        body: {
          error: `Invalid participant(s): ${invalid.join(", ")}. These agents are not registered in project "${projectId}".`,
        },
      };
    }
  }

  try {
    const result = startMeeting({
      projectId,
      channelName: body.channelName as string | undefined,
      participants: participants as string[],
      prompt: body.prompt as string | undefined,
      initiator: (body.initiator as string) ?? "dashboard",
    });
    return {
      status: 201,
      body: result,
      sse: {
        event: "meeting:started",
        payload: {
          channelId: result.channel.id,
          participants,
        },
      },
    };
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function runSendMeetingMessageCommand(
  projectId: string,
  channelId: string,
  body: Record<string, unknown>,
): ChannelCommandResult {
  const content = typeof body.content === "string" ? body.content : "";
  if (!content) {
    return { status: 400, body: { error: "content is required" } };
  }

  try {
    const message = sendChannelMessage({
      fromAgent: (body.fromAgent as string) ?? "dashboard",
      channelId,
      projectId,
      content,
    });
    return {
      status: 200,
      body: message,
      sse: {
        event: "meeting:turn",
        payload: { channelId, messageId: message.id },
      },
    };
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function runEndMeetingCommand(
  projectId: string,
  channelId: string,
  body: Record<string, unknown>,
): ChannelCommandResult {
  try {
    const channel = concludeMeeting(
      projectId,
      channelId,
      (body.actor as string) ?? "dashboard",
    );
    return {
      status: 200,
      body: channel,
      sse: {
        event: "meeting:ended",
        payload: { channelId },
      },
    };
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function runSendThreadMessageCommand(
  projectId: string,
  threadId: string,
  body: Record<string, unknown>,
): ChannelCommandResult {
  const content = typeof body.content === "string" ? body.content : "";
  if (!content) {
    return { status: 400, body: { error: "content is required" } };
  }

  try {
    const message = sendChannelMessage({
      fromAgent: (body.fromAgent as string) ?? "dashboard",
      channelId: threadId,
      projectId,
      content,
    });
    return {
      status: 200,
      body: message,
      sse: {
        event: "message:new",
        payload: { threadId, messageId: message.id },
      },
    };
  } catch (error) {
    return {
      status: 400,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}
