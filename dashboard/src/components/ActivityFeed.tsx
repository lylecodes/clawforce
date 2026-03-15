import { useEffect, useRef } from "react";
import { useAppStore, type ActivityEvent } from "../store";

const EVENT_ICONS: Record<string, string> = {
  "budget:update": "$",
  "task:update": "T",
  "agent:status": "A",
  "approval:new": "!",
  "approval:resolved": "V",
  "message:new": "M",
  "plan:update": "P",
  "escalation:new": "E",
  "meeting:started": "S",
  "meeting:turn": "C",
  "meeting:ended": "X",
  "config:changed": "C",
};

const EVENT_COLORS: Record<string, string> = {
  "budget:update": "bg-cf-accent-orange/20 text-cf-accent-orange",
  "task:update": "bg-cf-accent-blue/20 text-cf-accent-blue",
  "agent:status": "bg-cf-accent-green/20 text-cf-accent-green",
  "approval:new": "bg-cf-accent-purple/20 text-cf-accent-purple",
  "approval:resolved": "bg-cf-accent-green/20 text-cf-accent-green",
  "message:new": "bg-cf-accent-blue/20 text-cf-accent-blue",
  "escalation:new": "bg-cf-accent-red/20 text-cf-accent-red",
  "config:changed": "bg-cf-accent-orange/20 text-cf-accent-orange",
};

function formatEventDescription(event: ActivityEvent): string {
  const data = event.data;
  switch (event.type) {
    case "budget:update":
      return `Budget updated${data.agentId ? ` for ${data.agentId}` : ""}`;
    case "task:update":
      return `Task ${data.taskId ?? "unknown"} ${data.newState ? `-> ${data.newState}` : "updated"}`;
    case "agent:status":
      return `Agent ${data.agentId ?? "unknown"} is now ${data.status ?? "unknown"}`;
    case "approval:new":
      return `New approval: ${data.title ?? data.proposalId ?? "proposal"}`;
    case "approval:resolved":
      return `Approval ${data.proposalId ?? ""} ${data.status ?? "resolved"}`;
    case "message:new":
      return `New message from ${data.from ?? "agent"}`;
    case "escalation:new":
      return `Escalation: ${data.reason ?? "issue raised"}`;
    case "config:changed":
      return `Config updated${data.section ? `: ${data.section}` : ""}`;
    default:
      return event.type;
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ActivityFeed() {
  const events = useAppStore((s) => s.activityEvents);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to top on new events
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [events.length]);

  return (
    <div className="bg-cf-bg-secondary border border-cf-border rounded-lg flex flex-col h-full">
      <div className="px-4 py-3 border-b border-cf-border-muted flex items-center justify-between">
        <h3 className="text-sm font-semibold text-cf-text-primary">Activity Feed</h3>
        <span className="text-xxs text-cf-text-muted font-mono">
          {events.length} events
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto max-h-[400px]">
        {events.length === 0 ? (
          <div className="p-4 text-center text-cf-text-muted text-sm">
            No activity yet. Events will appear here in real-time.
          </div>
        ) : (
          <div className="divide-y divide-cf-border-muted">
            {events.map((event) => (
              <div
                key={event.id}
                className="px-4 py-2.5 flex items-start gap-3 hover:bg-cf-bg-tertiary/50 transition-colors"
              >
                <span
                  className={`w-6 h-6 rounded flex items-center justify-center text-xxs font-bold shrink-0 mt-0.5 ${
                    EVENT_COLORS[event.type] ?? "bg-cf-bg-tertiary text-cf-text-muted"
                  }`}
                >
                  {EVENT_ICONS[event.type] ?? "?"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-cf-text-primary truncate">
                    {formatEventDescription(event)}
                  </p>
                  <p className="text-xxs text-cf-text-muted mt-0.5">
                    {formatTime(event.timestamp)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
