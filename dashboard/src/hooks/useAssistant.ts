import { useState, useCallback, useRef, useEffect } from "react";
import { useAppStore } from "../store";

export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

const ASSISTANT_AGENT_ID = "clawforce-assistant";
const BASE = "/clawforce/api";

/**
 * Manages chat state for the dashboard assistant widget.
 * Sends messages via POST and subscribes to SSE for streamed responses.
 */
export function useAssistant() {
  const activeDomain = useAppStore((s) => s.activeDomain);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Clean up any active SSE stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!activeDomain || !content.trim()) return;

      const userMsg: AssistantMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: content.trim(),
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setIsSending(true);

      // Abort any in-flight stream
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(
          `${BASE}/${activeDomain}/agents/${ASSISTANT_AGENT_ID}/message`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: content.trim() }),
            signal: controller.signal,
          },
        );

        setIsSending(false);

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              content: `Error: ${errText || res.statusText}`,
              timestamp: Date.now(),
            },
          ]);
          return;
        }

        // Stream SSE response
        setIsStreaming(true);
        const assistantMsgId = `asst-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          { id: assistantMsgId, role: "assistant", content: "", timestamp: Date.now() },
        ]);

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") continue;
                try {
                  const parsed = JSON.parse(data) as { content?: string };
                  if (parsed.content) {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantMsgId
                          ? { ...m, content: m.content + parsed.content }
                          : m,
                      ),
                    );
                  }
                } catch {
                  // non-JSON SSE line, append raw text
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? { ...m, content: m.content + data }
                        : m,
                    ),
                  );
                }
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              content: "Failed to reach the assistant. Please try again.",
              timestamp: Date.now(),
            },
          ]);
        }
      } finally {
        setIsSending(false);
        setIsStreaming(false);
      }
    },
    [activeDomain],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    sendMessage,
    clearMessages,
    isSending,
    isStreaming,
  };
}
