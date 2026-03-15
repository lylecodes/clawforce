import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store";
import { api } from "../api/client";
import type { Thread, Message, Meeting } from "../api/types";

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
  const meetings: Meeting[] = meetingsData?.meetings ?? [];

  const messageThreads = threads.filter((t) => t.type === "message");
  const escalationThreads = threads.filter((t) => t.type === "escalation");
  const meetingThreads = threads.filter((t) => t.type === "meeting");

  return {
    threads,
    messageThreads,
    escalationThreads,
    meetingThreads,
    meetings,
    isLoading: threadsLoading || meetingsLoading,
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

  const messages: Message[] = data?.messages ?? [];

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
