/**
 * Clawforce — Meeting orchestration
 *
 * Sequential round-robin meetings dispatched through the cron service.
 * Each participant gets a turn, sees the full transcript so far,
 * and adds their response. Manager goes last.
 */

import type { DatabaseSync } from "node:sqlite";
import { safeLog } from "../diagnostics.js";
import { getDb } from "../db.js";
import { ingestEvent } from "../events/store.js";
import { checkMeetingConcurrency } from "../safety.js";
import type { Channel, MeetingConfig } from "../types.js";
import { buildChannelTranscript, sendChannelMessage } from "./messages.js";
import { createChannel, getChannel, getChannelByName, concludeChannel, updateChannelMetadata } from "./store.js";
import { getDispatchInjector } from "../dispatch/inject-dispatch.js";

/**
 * Start a meeting: create/reuse a meeting channel and dispatch the first participant.
 */
export function startMeeting(
  params: {
    projectId: string;
    channelName?: string;
    channelId?: string;
    participants: string[];
    prompt?: string;
    initiator: string;
  },
  dbOverride?: DatabaseSync,
): { channel: Channel; dispatched: boolean } {
  const db = dbOverride ?? getDb(params.projectId);

  if (params.participants.length === 0) {
    throw new Error("Meeting must have at least one participant");
  }

  // Check meeting concurrency limit
  const meetingCheck = checkMeetingConcurrency(params.projectId, db);
  if (!meetingCheck.ok) {
    throw new Error(meetingCheck.reason);
  }

  // Create or find the meeting channel
  let channel: Channel | null = null;
  if (params.channelId) {
    channel = getChannel(params.projectId, params.channelId, db);
  } else if (params.channelName) {
    channel = getChannelByName(params.projectId, params.channelName, db);
  }

  if (channel && channel.status !== "active") {
    throw new Error(`Channel "${channel.name}" is ${channel.status}, cannot start meeting`);
  }

  if (!channel) {
    const name = params.channelName ?? `meeting-${Date.now()}`;
    channel = createChannel({
      projectId: params.projectId,
      name,
      type: "meeting",
      members: [params.initiator, ...params.participants],
      createdBy: params.initiator,
    }, db);
  }

  // Set meeting config in metadata
  const meetingConfig: MeetingConfig = {
    participants: params.participants,
    currentTurn: 0,
    prompt: params.prompt,
  };
  const metadata = { ...(channel.metadata ?? {}), meetingConfig };
  updateChannelMetadata(params.projectId, channel.id, metadata, db);
  channel = { ...channel, metadata };

  // Emit event
  ingestEvent(params.projectId, "meeting_started", "internal", {
    channelId: channel.id,
    channelName: channel.name,
    participants: params.participants,
    initiator: params.initiator,
  }, `meeting-started:${channel.id}`, db);

  // Dispatch first participant
  const firstAgent = params.participants[0]!;
  const dispatched = dispatchMeetingTurn(params.projectId, channel, firstAgent, 0, meetingConfig);

  return { channel, dispatched };
}

/**
 * Advance to the next meeting turn.
 * Called by the event router when meeting_turn_completed fires.
 */
export function advanceMeetingTurn(
  projectId: string,
  channelId: string,
  dbOverride?: DatabaseSync,
): { nextAgent: string | null; turnIndex: number; done: boolean } {
  const db = dbOverride ?? getDb(projectId);
  const channel = getChannel(projectId, channelId, db);
  if (!channel) throw new Error(`Channel ${channelId} not found`);
  if (channel.status !== "active") return { nextAgent: null, turnIndex: -1, done: true };

  const meetingConfig = channel.metadata?.meetingConfig as MeetingConfig | undefined;
  if (!meetingConfig) throw new Error(`Channel ${channelId} has no meeting config`);

  const nextTurn = meetingConfig.currentTurn + 1;

  if (nextTurn >= meetingConfig.participants.length) {
    // All participants have gone — meeting is done
    return { nextAgent: null, turnIndex: nextTurn, done: true };
  }

  // Update turn counter
  const updatedConfig: MeetingConfig = { ...meetingConfig, currentTurn: nextTurn };
  const metadata = { ...(channel.metadata ?? {}), meetingConfig: updatedConfig };
  updateChannelMetadata(projectId, channelId, metadata, db);

  const nextAgent = meetingConfig.participants[nextTurn]!;
  dispatchMeetingTurn(projectId, channel, nextAgent, nextTurn, updatedConfig);

  return { nextAgent, turnIndex: nextTurn, done: false };
}

/**
 * Conclude a meeting. Sets status to "concluded".
 */
export function concludeMeeting(
  projectId: string,
  channelId: string,
  actor: string,
  dbOverride?: DatabaseSync,
): Channel {
  const db = dbOverride ?? getDb(projectId);
  const channel = concludeChannel(projectId, channelId, db);

  ingestEvent(projectId, "meeting_concluded", "internal", {
    channelId,
    channelName: channel.name,
    concludedBy: actor,
  }, `meeting-concluded:${channelId}`, db);

  return channel;
}

/**
 * Get the current meeting status.
 */
export function getMeetingStatus(
  projectId: string,
  channelId: string,
  dbOverride?: DatabaseSync,
): {
  channel: Channel;
  currentTurn: number;
  participants: string[];
  transcript: string;
  done: boolean;
} | null {
  const db = dbOverride ?? getDb(projectId);
  const channel = getChannel(projectId, channelId, db);
  if (!channel) return null;

  const meetingConfig = channel.metadata?.meetingConfig as MeetingConfig | undefined;
  const participants = meetingConfig?.participants ?? [];
  const currentTurn = meetingConfig?.currentTurn ?? 0;
  const transcript = buildChannelTranscript(projectId, channelId, {}, db);
  const done = channel.status === "concluded" || currentTurn >= participants.length;

  return { channel, currentTurn, participants, transcript, done };
}

/**
 * Dispatch a meeting turn via direct injection.
 * Injects a message with a [clawforce:meeting=...] tag into an isolated session.
 */
function dispatchMeetingTurn(
  projectId: string,
  channel: Channel,
  agentId: string,
  turnIndex: number,
  config: MeetingConfig,
): boolean {
  const injector = getDispatchInjector();
  if (!injector) {
    safeLog("meeting.dispatch", "Dispatch injector not available — cannot dispatch meeting turn");
    return false;
  }

  const transcript = buildChannelTranscript(projectId, channel.id);
  const meetingPrompt = config.prompt ?? "Report your current status, raise any blockers, and note key updates.";

  const message = [
    `[clawforce:meeting=${channel.id}:${turnIndex}]`,
    "",
    `You are in a meeting on channel "#${channel.name}".`,
    `It is your turn (${turnIndex + 1} of ${config.participants.length}).`,
    "",
    meetingPrompt,
    "",
    transcript ? `**Transcript so far:**\n${transcript}` : "_No messages yet — you are first._",
    "",
    `Use \`clawforce_channel send\` with channel_id="${channel.id}" to add your response.`,
  ].join("\n");

  const sessionKey = `agent:${agentId}:meeting:${channel.id}:${turnIndex}`;
  injector({ sessionKey, message }).catch(err => {
    safeLog("meeting.dispatch.inject", err);
  });

  return true;
}
