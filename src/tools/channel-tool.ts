/**
 * Clawforce — Channel management tool
 *
 * Provides agents with channel and meeting management:
 * create, join, leave, send, list, history, start_meeting, meeting_status.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema-helpers.js";
import {
  createChannel,
  getChannel,
  getChannelByName,
  listChannels,
  addMember,
  removeMember,
} from "../channels/store.js";
import { sendChannelMessage, buildChannelTranscript } from "../channels/messages.js";
import { startMeeting, getMeetingStatus } from "../channels/meeting.js";
import { notifyChannelMessage } from "../channels/notify.js";
import { ingestEvent } from "../events/store.js";
import type { ToolResult } from "./common.js";
import { jsonResult, readStringParam, readNumberParam, resolveProjectId, safeExecute } from "./common.js";

const CHANNEL_ACTIONS = [
  "create", "join", "leave", "send", "list",
  "history", "start_meeting", "meeting_status",
] as const;

const ClawforceChannelSchema = Type.Object({
  action: stringEnum(CHANNEL_ACTIONS, { description: "Action to perform." }),
  project_id: Type.Optional(Type.String({ description: "Project identifier." })),
  channel_id: Type.Optional(Type.String({ description: "Channel ID." })),
  channel_name: Type.Optional(Type.String({ description: "Channel name (for create or lookup)." })),
  type: Type.Optional(Type.String({ description: "Channel type: topic or meeting (for create, default: topic)." })),
  content: Type.Optional(Type.String({ description: "Message content (for send)." })),
  members: Type.Optional(Type.Array(Type.String(), { description: "Initial member agent IDs (for create)." })),
  participants: Type.Optional(Type.Array(Type.String(), { description: "Ordered participant list (for start_meeting)." })),
  prompt: Type.Optional(Type.String({ description: "Meeting prompt (for start_meeting)." })),
  telegram_group_id: Type.Optional(Type.String({ description: "Telegram group ID for mirroring (for create)." })),
  limit: Type.Optional(Type.Number({ description: "Max results (for list/history)." })),
});

export function createClawforceChannelTool(options?: {
  agentSessionKey?: string;
  projectId?: string;
}) {
  return {
    label: "Channel Management",
    name: "clawforce_channel",
    description: [
      "Manage channels and meetings: create channels, send messages, start meetings.",
      "",
      "Actions:",
      "  create — Create a new channel",
      "  join — Join a channel",
      "  leave — Leave a channel",
      "  send — Send a message to a channel",
      "  list — List channels you belong to",
      "  history — View recent channel transcript",
      "  start_meeting — Start a round-robin meeting (manager only)",
      "  meeting_status — Check meeting state",
    ].join("\n"),
    parameters: ClawforceChannelSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      return safeExecute(async () => {
        const action = readStringParam(params, "action", { required: true })!;
        const resolved = resolveProjectId(params, options?.projectId);
        if (resolved.error) return jsonResult({ ok: false, reason: resolved.error });
        const projectId = resolved.projectId!;
        const agentId = options?.agentSessionKey ?? "unknown";

        switch (action) {
          case "create": {
            const name = readStringParam(params, "channel_name", { required: true })!;
            const type = readStringParam(params, "type") as "topic" | "meeting" | undefined;
            const members = params.members as string[] | undefined;
            const telegramGroupId = readStringParam(params, "telegram_group_id");

            const metadata: Record<string, unknown> = {};
            if (telegramGroupId) metadata.telegramGroupId = telegramGroupId;

            const channel = createChannel({
              projectId,
              name,
              type: type ?? "topic",
              members,
              createdBy: agentId,
              metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
            });

            ingestEvent(projectId, "channel_created", "internal", {
              channelId: channel.id,
              channelName: channel.name,
              type: channel.type,
              createdBy: agentId,
            });

            return jsonResult({ ok: true, channel });
          }

          case "join": {
            const channel = resolveChannel(projectId, params);
            if (!channel) return jsonResult({ ok: false, reason: "Channel not found." });

            const updated = addMember(projectId, channel.id, agentId);
            return jsonResult({ ok: true, channel: updated });
          }

          case "leave": {
            const channel = resolveChannel(projectId, params);
            if (!channel) return jsonResult({ ok: false, reason: "Channel not found." });

            const updated = removeMember(projectId, channel.id, agentId);
            return jsonResult({ ok: true, channel: updated });
          }

          case "send": {
            const channel = resolveChannel(projectId, params);
            if (!channel) return jsonResult({ ok: false, reason: "Channel not found." });

            const content = readStringParam(params, "content", { required: true })!;

            const message = sendChannelMessage({
              fromAgent: agentId,
              channelId: channel.id,
              projectId,
              content,
            });

            // Fire-and-forget Telegram mirror
            notifyChannelMessage(channel, message).catch(() => {});

            return jsonResult({ ok: true, messageId: message.id });
          }

          case "list": {
            const limit = readNumberParam(params, "limit") ?? 20;
            const channels = listChannels(projectId, {
              memberAgent: agentId,
              status: "active",
              limit,
            });

            return jsonResult({
              ok: true,
              channels: channels.map(ch => ({
                id: ch.id,
                name: ch.name,
                type: ch.type,
                memberCount: ch.members.length,
                status: ch.status,
              })),
            });
          }

          case "history": {
            const channel = resolveChannel(projectId, params);
            if (!channel) return jsonResult({ ok: false, reason: "Channel not found." });

            const limit = readNumberParam(params, "limit") ?? 50;
            const transcript = buildChannelTranscript(projectId, channel.id, { limit });

            return jsonResult({
              ok: true,
              channelName: channel.name,
              transcript: transcript || "(no messages)",
            });
          }

          case "start_meeting": {
            const participants = params.participants as string[] | undefined;
            if (!participants || participants.length === 0) {
              return jsonResult({ ok: false, reason: "participants array is required for start_meeting." });
            }

            const channelName = readStringParam(params, "channel_name");
            const channelId = readStringParam(params, "channel_id");
            const prompt = readStringParam(params, "prompt");

            const result = startMeeting({
              projectId,
              channelName: channelName ?? undefined,
              channelId: channelId ?? undefined,
              participants,
              prompt: prompt ?? undefined,
              initiator: agentId,
            });

            return jsonResult({
              ok: true,
              channelId: result.channel.id,
              channelName: result.channel.name,
              dispatched: result.dispatched,
              participants,
            });
          }

          case "meeting_status": {
            const channel = resolveChannel(projectId, params);
            if (!channel) return jsonResult({ ok: false, reason: "Channel not found." });

            const status = getMeetingStatus(projectId, channel.id);
            if (!status) return jsonResult({ ok: false, reason: "No meeting data for this channel." });

            return jsonResult({
              ok: true,
              channelName: status.channel.name,
              status: status.channel.status,
              currentTurn: status.currentTurn,
              totalParticipants: status.participants.length,
              participants: status.participants,
              done: status.done,
              transcript: status.transcript || "(no messages yet)",
            });
          }

          default:
            return jsonResult({ ok: false, reason: `Unknown action: ${action}` });
        }
      });
    },
  };
}

function resolveChannel(projectId: string, params: Record<string, unknown>) {
  const channelId = readStringParam(params, "channel_id");
  if (channelId) return getChannel(projectId, channelId);

  const channelName = readStringParam(params, "channel_name");
  if (channelName) return getChannelByName(projectId, channelName);

  return null;
}
