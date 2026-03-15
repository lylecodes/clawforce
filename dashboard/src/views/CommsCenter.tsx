import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store";
import { api } from "../api/client";
import {
  useComms,
  useThreadMessages,
  useMeetingActions,
  type CommsTab,
} from "../hooks/useComms";
import { ThreadList } from "../components/ThreadList";
import { ChatMessage } from "../components/ChatMessage";
import { MessageInput } from "../components/MessageInput";
import { MeetingHeader } from "../components/MeetingHeader";
import type { Meeting } from "../api/types";

export function CommsCenter() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const [activeTab, setActiveTab] = useState<CommsTab>("messages");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [showNewMeeting, setShowNewMeeting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const {
    messageThreads,
    escalationThreads,
    meetingThreads,
    meetings,
  } = useComms();

  const { messages, isLoading: messagesLoading, sendMessage, isSending } =
    useThreadMessages(selectedThreadId);

  const {
    createMeeting,
    isCreating,
    sendMeetingMessage,
    isSendingMessage,
    endMeeting,
    isEnding,
  } = useMeetingActions();

  // Derive the active thread list based on the selected tab
  const activeThreads =
    activeTab === "messages"
      ? messageThreads
      : activeTab === "escalations"
        ? escalationThreads
        : meetingThreads;

  // Find the selected thread and active meeting
  const selectedThread = activeThreads.find((t) => t.id === selectedThreadId) ?? null;
  const activeMeeting: Meeting | null =
    selectedThread?.type === "meeting"
      ? meetings.find(
          (m) => m.id === selectedThreadId && m.status === "active",
        ) ?? null
      : null;

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  // Handle sending based on meeting vs thread
  const handleSend = useCallback(
    (content: string) => {
      if (activeMeeting) {
        sendMeetingMessage({ meetingId: activeMeeting.id, content });
      } else if (selectedThreadId) {
        sendMessage(content);
      }
    },
    [activeMeeting, selectedThreadId, sendMeetingMessage, sendMessage],
  );

  const handleEndMeeting = useCallback(() => {
    if (activeMeeting) {
      endMeeting(activeMeeting.id);
    }
  }, [activeMeeting, endMeeting]);

  if (!activeDomain) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <div className="text-center">
          <p className="text-cf-text-secondary text-lg mb-2">
            No domain selected
          </p>
          <p className="text-cf-text-muted text-sm">
            Select a domain from the switcher above to view communications.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-120px)] bg-cf-bg-primary rounded-lg border border-cf-border overflow-hidden">
      {/* Left sidebar: thread list */}
      <ThreadList
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          setSelectedThreadId(null);
        }}
        threads={activeThreads}
        selectedThreadId={selectedThreadId}
        onSelectThread={setSelectedThreadId}
      />

      {/* Right panel: conversation */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedThreadId ? (
          <EmptyConversation
            onNewMeeting={() => setShowNewMeeting(true)}
          />
        ) : (
          <>
            {/* Meeting header if active meeting */}
            {activeMeeting && (
              <MeetingHeader
                meeting={activeMeeting}
                onEnd={handleEndMeeting}
                isEnding={isEnding}
              />
            )}

            {/* Conversation header for non-meetings */}
            {!activeMeeting && selectedThread && (
              <div className="px-4 py-3 border-b border-cf-border bg-cf-bg-secondary">
                <h3 className="text-sm font-semibold text-cf-text-primary">
                  {selectedThread.title ?? selectedThread.participants.join(", ")}
                </h3>
                <p className="text-xxs text-cf-text-muted">
                  {selectedThread.participants.length} participants
                </p>
              </div>
            )}

            {/* Messages area */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto py-3"
            >
              {messagesLoading ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-cf-text-muted text-sm">
                    Loading messages...
                  </p>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-cf-text-muted text-sm">
                    No messages in this thread yet.
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {messages.map((msg) => (
                    <ChatMessage key={msg.id} message={msg} />
                  ))}
                </div>
              )}
            </div>

            {/* Message input */}
            <MessageInput
              onSend={handleSend}
              isSending={isSending || isSendingMessage}
              placeholder={
                activeMeeting
                  ? "Participate in the meeting..."
                  : "Type a message..."
              }
            />
          </>
        )}
      </div>

      {/* New Meeting Modal */}
      {showNewMeeting && (
        <NewMeetingModal
          domain={activeDomain}
          onClose={() => setShowNewMeeting(false)}
          onCreate={(data) => {
            createMeeting(data);
            setShowNewMeeting(false);
            setActiveTab("meetings");
          }}
          isCreating={isCreating}
        />
      )}
    </div>
  );
}

function EmptyConversation({ onNewMeeting }: { onNewMeeting: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center">
      <p className="text-cf-text-secondary text-sm mb-2">
        Select a thread to view messages
      </p>
      <p className="text-cf-text-muted text-xs mb-4">
        Or start a new conversation
      </p>
      <button
        onClick={onNewMeeting}
        className="px-4 py-2 bg-cf-accent-blue text-white text-xs font-semibold rounded-lg hover:bg-cf-accent-blue/80 transition-colors"
      >
        New Meeting
      </button>
    </div>
  );
}

function NewMeetingModal({
  domain,
  onClose,
  onCreate,
  isCreating,
}: {
  domain: string;
  onClose: () => void;
  onCreate: (data: { participants: string[]; topic?: string }) => void;
  isCreating: boolean;
}) {
  const [topic, setTopic] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: agents } = useQuery({
    queryKey: ["agents", domain],
    queryFn: () => api.getAgents(domain),
    enabled: !!domain,
    staleTime: 60_000,
  });

  const agentList = agents ?? [];

  const handleToggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (selected.size === 0) return;
    onCreate({
      participants: Array.from(selected),
      topic: topic.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-cf-bg-secondary border border-cf-border rounded-lg w-full max-w-md mx-4 shadow-xl">
        <div className="px-4 py-3 border-b border-cf-border-muted">
          <h3 className="text-sm font-semibold text-cf-text-primary">
            New Meeting
          </h3>
          <p className="text-xxs text-cf-text-muted mt-0.5">
            Select agents to invite to this meeting
          </p>
        </div>

        <div className="p-4 space-y-4">
          {/* Topic */}
          <div>
            <label className="text-xxs text-cf-text-secondary font-semibold uppercase tracking-wider block mb-1.5">
              Topic (optional)
            </label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What should we discuss?"
              className="w-full bg-cf-bg-tertiary border border-cf-border rounded px-3 py-2 text-xs text-cf-text-primary placeholder:text-cf-text-muted focus:outline-none focus:border-cf-accent-blue"
            />
          </div>

          {/* Participants */}
          <div>
            <label className="text-xxs text-cf-text-secondary font-semibold uppercase tracking-wider block mb-1.5">
              Participants ({selected.size} selected)
            </label>
            <div className="max-h-[200px] overflow-y-auto space-y-1">
              {agentList.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => handleToggle(agent.id)}
                  className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded text-xs transition-colors ${
                    selected.has(agent.id)
                      ? "bg-cf-accent-blue/15 text-cf-text-primary border border-cf-accent-blue/30"
                      : "bg-cf-bg-tertiary text-cf-text-secondary hover:bg-cf-bg-hover border border-transparent"
                  }`}
                >
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold ${
                      selected.has(agent.id)
                        ? "bg-cf-accent-blue text-white"
                        : "bg-cf-bg-secondary text-cf-text-muted"
                    }`}
                  >
                    {agent.id.charAt(0).toUpperCase()}
                  </span>
                  <span className="flex-1">{agent.id}</span>
                  {agent.title && (
                    <span className="text-xxs text-cf-text-muted">
                      {agent.title}
                    </span>
                  )}
                </button>
              ))}
              {agentList.length === 0 && (
                <p className="text-cf-text-muted text-xs p-2">
                  No agents available.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-4 py-3 border-t border-cf-border-muted flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-cf-text-secondary hover:text-cf-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={selected.size === 0 || isCreating}
            className="px-4 py-1.5 bg-cf-accent-blue text-white text-xs font-semibold rounded hover:bg-cf-accent-blue/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isCreating ? "Starting..." : "Start Meeting"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CommsCenter;
