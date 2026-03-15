import type { Thread } from "../api/types";
import type { CommsTab } from "../hooks/useComms";

type ThreadListProps = {
  activeTab: CommsTab;
  onTabChange: (tab: CommsTab) => void;
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
};

const TABS: { id: CommsTab; label: string }[] = [
  { id: "messages", label: "Messages" },
  { id: "escalations", label: "Escalations" },
  { id: "meetings", label: "Meetings" },
];

function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ThreadList({
  activeTab,
  onTabChange,
  threads,
  selectedThreadId,
  onSelectThread,
}: ThreadListProps) {
  return (
    <div className="w-[280px] shrink-0 border-r border-cf-border bg-cf-bg-secondary flex flex-col h-full">
      {/* Tabs */}
      <div className="flex border-b border-cf-border-muted">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex-1 py-2.5 text-xxs font-semibold uppercase tracking-wider transition-colors ${
              activeTab === tab.id
                ? "text-cf-accent-blue border-b-2 border-cf-accent-blue"
                : "text-cf-text-muted hover:text-cf-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <div className="p-4 text-center text-cf-text-muted text-xs">
            No {activeTab} yet.
          </div>
        ) : (
          <div className="divide-y divide-cf-border-muted">
            {threads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => onSelectThread(thread.id)}
                className={`w-full text-left px-3 py-3 hover:bg-cf-bg-tertiary/50 transition-colors ${
                  selectedThreadId === thread.id ? "bg-cf-bg-tertiary" : ""
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Active meeting indicator */}
                    {thread.isActive && (
                      <span className="w-2 h-2 rounded-full bg-cf-accent-blue animate-pulse shrink-0" />
                    )}
                    <span className="text-xs font-medium text-cf-text-primary truncate">
                      {thread.title ?? thread.participants.join(", ")}
                    </span>
                  </div>
                  <span className="text-xxs text-cf-text-muted shrink-0 ml-2">
                    {formatTime(thread.lastTimestamp)}
                  </span>
                </div>

                {thread.lastMessage && (
                  <p className="text-xxs text-cf-text-secondary truncate">
                    {thread.lastMessage}
                  </p>
                )}

                {thread.unreadCount > 0 && (
                  <span className="mt-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-cf-accent-blue text-[9px] font-bold text-white">
                    {thread.unreadCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
