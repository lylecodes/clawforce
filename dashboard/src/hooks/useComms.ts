import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store";
import { api } from "../api/client";
import type { Thread, Message, Meeting, MessageRole } from "../api/types";

export type CommsTab = "messages" | "escalations" | "meetings";

export function useComms() {
  const activeDomain = useAppStore((s) => s.activeDomain);

  const { data: threadsData, isLoading: threadsLoading } = useQuery({
    queryKey: ["messages", activeDomain],
    queryFn: () => api.getMessages(activeDomain!),
    enabled: !!activeDomain,
    refetchInterval: 15_000,
  });

  const { data: meetingsData, isLoading: meetingsLoading } = useQuery({
    queryKey: ["meetings", activeDomain],
    queryFn: () => api.getMeetings(activeDomain!),
    enabled: !!activeDomain,
    refetchInterval: 10_000,
  });

  const threads: Thread[] = threadsData?.threads ?? [];
  // Meetings come from /meetings API as channel objects, not from /messages threads.
  // The raw shape is Channel: { id, name, members, status, createdAt, metadata }
  const rawMeetings: unknown[] = meetingsData?.meetings ?? [];
  const meetings: Meeting[] = rawMeetings.map((m: any) => ({
    id: m.id,
    topic: m.metadata?.meetingConfig?.prompt ?? m.name,
    participants: m.metadata?.meetingConfig?.participants ?? m.members ?? [],
    status: m.status === "active" ? "active" as const : "ended" as const,
    startedAt: m.createdAt ?? Date.now(),
    endedAt: m.concludedAt,
  }));

  const messageThreads = threads.filter((t) => t.type === "direct" || t.type === "message");
  const escalationThreads = threads.filter((t) => t.type === "escalation");
  // Convert meetings into Thread[] for the ThreadList component
  const meetingThreads: Thread[] = meetings.map((m) => ({
    id: m.id,
    type: "meeting" as const,
    participants: m.participants,
    title: m.topic ?? `Meeting`,
    lastTimestamp: m.startedAt,
    unreadCount: 0,
    isActive: m.status === "active",
  }));

  return {
    threads,
    messageThreads,
    escalationThreads,
    meetingThreads,
    meetings,
    isLoading: threadsLoading || meetingsLoading,
  };
}

/**
 * Map a backend message (fromAgent/createdAt/type shape) to the dashboard
 * Message type (from/timestamp/role shape) that ChatMessage expects.
 */
function mapBackendMessage(raw: Record<string, unknown>, threadId: string): Message {
  const fromAgent = (raw.fromAgent ?? raw.from_agent ?? raw.from ?? "") as string;
  const messageType = (raw.type ?? "") as string;

  // Derive role: dashboard user messages come from "dashboard",
  // escalations/delegations map to manager, everything else is employee.
  let role: MessageRole = "employee";
  if (fromAgent === "dashboard" || fromAgent === "user") {
    role = "user";
  } else if (messageType === "escalation" || messageType === "delegation") {
    role = "manager";
  }

  return {
    id: raw.id as string,
    threadId: (raw.threadId ?? raw.channelId ?? raw.channel_id ?? threadId) as string,
    from: fromAgent,
    role,
    content: (raw.content ?? "") as string,
    timestamp: (raw.timestamp ?? raw.createdAt ?? raw.created_at ?? Date.now()) as number,
    attachments: raw.attachments as string[] | undefined,
    linkedTaskId: raw.linkedTaskId as string | undefined,
    mentionedAgents: raw.mentionedAgents as string[] | undefined,
  };
}

export function useThreadMessages(threadId: string | null) {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["thread-messages", activeDomain, threadId],
    queryFn: () => api.getThreadMessages(activeDomain!, threadId!),
    enabled: !!activeDomain && !!threadId,
    refetchInterval: 5_000,
  });

  const sendMessageMutation = useMutation({
    mutationFn: (content: string) =>
      api.sendThreadMessage(activeDomain!, threadId!, content),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["thread-messages", activeDomain, threadId],
      });
      queryClient.invalidateQueries({
        queryKey: ["messages", activeDomain],
      });
    },
  });

  // Map backend message shape to dashboard Message shape.
  // The backend returns { fromAgent, createdAt, type, ... } while
  // ChatMessage expects { from, timestamp, role, ... }.
  const rawMessages = (data?.messages ?? []) as Record<string, unknown>[];
  const messages: Message[] = rawMessages.map((raw) =>
    mapBackendMessage(raw, threadId ?? ""),
  );

  return {
    messages,
    isLoading,
    sendMessage: sendMessageMutation.mutate,
    isSending: sendMessageMutation.isPending,
  };
}

export function useMeetingActions() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const queryClient = useQueryClient();

  const createMeetingMutation = useMutation({
    mutationFn: (data: { participants: string[]; topic?: string }) =>
      api.createMeeting(activeDomain!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings", activeDomain] });
      queryClient.invalidateQueries({ queryKey: ["messages", activeDomain] });
    },
  });

  const sendMeetingMessageMutation = useMutation({
    mutationFn: ({ meetingId, content }: { meetingId: string; content: string }) =>
      api.sendMeetingMessage(activeDomain!, meetingId, content),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ["thread-messages", activeDomain, vars.meetingId],
      });
    },
  });

  const endMeetingMutation = useMutation({
    mutationFn: (meetingId: string) => api.endMeeting(activeDomain!, meetingId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meetings", activeDomain] });
      queryClient.invalidateQueries({ queryKey: ["messages", activeDomain] });
    },
  });

  return {
    createMeeting: createMeetingMutation.mutate,
    isCreating: createMeetingMutation.isPending,
    sendMeetingMessage: sendMeetingMessageMutation.mutate,
    isSendingMessage: sendMeetingMessageMutation.isPending,
    endMeeting: endMeetingMutation.mutate,
    isEnding: endMeetingMutation.isPending,
  };
}
