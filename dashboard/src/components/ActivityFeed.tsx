import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore, type ActivityEvent } from "../store";
import { api } from "../api/client";

const EVENT_ICONS: Record<string, string> = {
  "budget:update": "$",
  "task:update": "T",
  "task_created": "T",
  "task_assigned": "A",
  "task_completed": "V",
  "task_failed": "X",
  "task_transitioned": "T",
  "agent:status": "A",
  "approval:new": "!",
  "approval:resolved": "V",
  "message:new": "M",
  "plan:update": "P",
  "escalation:new": "E",
  "dispatch_failed": "D",
  "dispatch_completed": "D",
  "dispatch_started": "D",
  "dispatch_succeeded": "D",
  "goal_created": "G",
  "goal_achieved": "G",
  "meeting:started": "S",
  "meeting:turn": "C",
  "meeting:ended": "X",
  "meeting_started": "M",
  "meeting_concluded": "M",
  "config:changed": "C",
  "cost_recorded": "$",
};

const EVENT_COLORS: Record<string, string> = {
  "budget:update": "bg-cf-accent-orange/20 text-cf-accent-orange",
  "task:update": "bg-cf-accent-blue/20 text-cf-accent-blue",
  "task_created": "bg-cf-accent-blue/20 text-cf-accent-blue",
  "task_assigned": "bg-cf-accent-blue/20 text-cf-accent-blue",
  "task_completed": "bg-cf-accent-green/20 text-cf-accent-green",
  "task_failed": "bg-cf-accent-red/20 text-cf-accent-red",
  "task_transitioned": "bg-cf-accent-blue/20 text-cf-accent-blue",
  "agent:status": "bg-cf-accent-green/20 text-cf-accent-green",
  "approval:new": "bg-cf-accent-purple/20 text-cf-accent-purple",
  "approval:resolved": "bg-cf-accent-green/20 text-cf-accent-green",
  "message:new": "bg-cf-accent-blue/20 text-cf-accent-blue",
  "escalation:new": "bg-cf-accent-red/20 text-cf-accent-red",
  "dispatch_failed": "bg-cf-accent-red/20 text-cf-accent-red",
  "dispatch_completed": "bg-cf-accent-green/20 text-cf-accent-green",
  "dispatch_started": "bg-cf-accent-blue/20 text-cf-accent-blue",
  "dispatch_succeeded": "bg-cf-accent-green/20 text-cf-accent-green",
  "goal_created": "bg-cf-accent-purple/20 text-cf-accent-purple",
  "goal_achieved": "bg-cf-accent-green/20 text-cf-accent-green",
  "meeting_started": "bg-cf-accent-purple/20 text-cf-accent-purple",
  "meeting_concluded": "bg-cf-accent-green/20 text-cf-accent-green",
  "config:changed": "bg-cf-accent-orange/20 text-cf-accent-orange",
  "cost_recorded": "bg-cf-accent-orange/20 text-cf-accent-orange",
};

function formatEventDescription(event: ActivityEvent): string {
  const data = event.data;
  switch (event.type) {
    case "budget:update":
      return `Budget updated${data.agentId ? ` for ${data.agentId}` : ""}`;
    case "task:update":
    case "task_transitioned":
      return `Task ${data.taskId ?? data.title ?? "unknown"} ${data.newState ? `→ ${data.newState}` : "updated"}`;
    case "task_created":
      return `Task created: ${data.title ?? data.taskId ?? "new task"}`;
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
    case "dispatch_failed":
      return `Dispatch failed: ${data.reason ?? data.error ?? "budget exceeded"}`;
    case "dispatch_completed":
      return `Dispatch completed for ${data.agentId ?? "agent"}`;
    case "task_assigned":
      return `Task assigned: ${data.title ?? data.taskId ?? "task"} → ${data.assignedTo ?? "agent"}`;
    case "task_completed":
      return `Task completed: ${data.title ?? data.taskId ?? "task"}`;
    case "task_failed":
      return `Task failed: ${data.title ?? data.taskId ?? "task"}${data.reason ? ` — ${data.reason}` : ""}`;
    case "dispatch_started":
      return `Dispatch started for ${data.agentId ?? "agent"}`;
    case "dispatch_succeeded":
      return `Dispatch succeeded for ${data.agentId ?? "agent"}`;
    case "goal_created":
      return `Goal created: ${data.title ?? data.goalId ?? "new goal"}`;
    case "goal_achieved":
      return `Goal achieved: ${data.title ?? data.goalId ?? "goal"}`;
    case "cost_recorded":
      return `Cost: $${((data.costCents as number ?? 0) / 100).toFixed(2)} for ${data.agentId ?? "agent"}`;
    case "meeting_started":
      return `Meeting started: ${data.channelName ?? data.channelId ?? "meeting"}`;
    case "meeting_concluded":
      return `Meeting concluded: ${data.channelName ?? data.channelId ?? "meeting"}`;
    case "config:changed":
      return `Config updated${data.section ? `: ${data.section}` : ""}`;
    default:
      return event.type.replace(/_/g, " ");
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ActivityFeed() {
  const realtimeEvents = useAppStore((s) => s.activityEvents);
  const activeDomain = useAppStore((s) => s.activeDomain);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch recent events from the API (historical data)
  const { data: apiEvents } = useQuery({
    queryKey: ["events", activeDomain, "feed"],
    queryFn: () => api.getEvents(activeDomain!, { limit: "50" }),
    enabled: !!activeDomain,
    refetchInterval: 30_000,
  });

  // Merge API events with real-time events (dedup by id, most recent first)
  // Then collapse consecutive events with the same type + description
  type DisplayEvent = ActivityEvent & { count?: number };

  const events: DisplayEvent[] = useMemo(() => {
    const fromApi: ActivityEvent[] = (apiEvents?.events ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      timestamp: e.timestamp || (e as Record<string, unknown>).createdAt as number || 0,
      data: e.payload,
    }));
    const seenIds = new Set(realtimeEvents.map((e) => e.id));
    const merged = [...realtimeEvents, ...fromApi.filter((e) => !seenIds.has(e.id))];
    merged.sort((a, b) => b.timestamp - a.timestamp);
    const sorted = merged.slice(0, 200);

    // Collapse consecutive events with same type + same description
    const collapsed: DisplayEvent[] = [];
    for (const event of sorted) {
      const desc = formatEventDescription(event);
      const prev = collapsed[collapsed.length - 1];
      if (prev && prev.type === event.type && formatEventDescription(prev) === desc) {
        prev.count = (prev.count ?? 1) + 1;
      } else {
        collapsed.push({ ...event, count: 1 });
      }
    }

    return collapsed.slice(0, 100);
  }, [realtimeEvents, apiEvents]);

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
                    {event.count && event.count > 1 && (
                      <span className="ml-1.5 text-xxs font-semibold text-cf-text-muted bg-cf-bg-tertiary rounded px-1 py-0.5">
                        x{event.count}
                      </span>
                    )}
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
