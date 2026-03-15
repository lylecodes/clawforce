import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectSSE } from "../api/sse";
import { useAppStore } from "../store";
import type { SSEEventType } from "../api/types";

/**
 * Maintains an SSE connection for the given domain.
 * Dispatches events to the Zustand store and invalidates React Query caches.
 */
export function useSSEConnection(domain: string | null) {
  const queryClient = useQueryClient();
  const addActivityEvent = useAppStore((s) => s.addActivityEvent);
  const addEventRef = useRef(addActivityEvent);
  addEventRef.current = addActivityEvent;

  useEffect(() => {
    if (!domain) return;

    const cleanup = connectSSE(domain, (event: SSEEventType, data: unknown) => {
      // Add to activity feed
      addEventRef.current({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: event,
        timestamp: Date.now(),
        data: (data as Record<string, unknown>) ?? {},
      });

      // Invalidate relevant React Query caches
      switch (event) {
        case "budget:update":
          queryClient.invalidateQueries({ queryKey: ["dashboard", domain] });
          queryClient.invalidateQueries({ queryKey: ["budget", domain] });
          break;
        case "task:update":
          queryClient.invalidateQueries({ queryKey: ["dashboard", domain] });
          queryClient.invalidateQueries({ queryKey: ["tasks", domain] });
          break;
        case "agent:status":
          queryClient.invalidateQueries({ queryKey: ["dashboard", domain] });
          queryClient.invalidateQueries({ queryKey: ["agents", domain] });
          break;
        case "approval:new":
        case "approval:resolved":
          queryClient.invalidateQueries({ queryKey: ["dashboard", domain] });
          queryClient.invalidateQueries({ queryKey: ["approvals", domain] });
          break;
        case "message:new":
          queryClient.invalidateQueries({ queryKey: ["messages", domain] });
          break;
        case "config:changed":
          queryClient.invalidateQueries({ queryKey: ["config", domain] });
          break;
        default:
          // For other events, just refresh the dashboard
          queryClient.invalidateQueries({ queryKey: ["dashboard", domain] });
      }
    });

    return cleanup;
  }, [domain, queryClient]);
}
