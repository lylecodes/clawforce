import { useState, useRef, useEffect } from "react";
import { useAssistant, type AssistantMessage } from "../hooks/useAssistant";
import { useAppStore } from "../store";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AssistantBubble({ message }: { message: AssistantMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-2 px-3 py-1.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {/* Avatar */}
      <div
        className={`w-6 h-6 rounded-full flex items-center justify-center text-xxs font-bold shrink-0 border ${
          isUser
            ? "bg-cf-accent-purple/10 border-cf-accent-purple/30 text-cf-accent-purple"
            : "bg-cf-accent-blue/10 border-cf-accent-blue/30 text-cf-accent-blue"
        }`}
      >
        {isUser ? "U" : "C"}
      </div>

      {/* Content */}
      <div className={`max-w-[80%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`flex items-center gap-1.5 mb-0.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}
        >
          <span
            className={`text-xxs font-semibold ${
              isUser ? "text-cf-accent-purple" : "text-cf-accent-blue"
            }`}
          >
            {isUser ? "You" : "Assistant"}
          </span>
          <span className="text-xxs text-cf-text-muted">{formatTime(message.timestamp)}</span>
        </div>
        <div
          className={`rounded-lg border px-2.5 py-1.5 text-xs text-cf-text-primary leading-relaxed ${
            isUser
              ? "bg-cf-accent-purple/10 border-cf-accent-purple/30"
              : "bg-cf-accent-blue/10 border-cf-accent-blue/30"
          }`}
        >
          {message.content.split("\n").map((line, i) => (
            <p key={i} className={i > 0 ? "mt-1" : ""}>
              {line || "\u00A0"}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AssistantWidget() {
  const assistantOpen = useAppStore((s) => s.assistantOpen);
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);
  const assistantInitialContext = useAppStore((s) => s.assistantInitialContext);
  const clearAssistantContext = useAppStore((s) => s.clearAssistantContext);

  const isOpen = assistantOpen;
  const setIsOpen = setAssistantOpen;

  const { messages, sendMessage, clearMessages, isSending, isStreaming } = useAssistant();
  const [inputValue, setInputValue] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const contextSentRef = useRef(false);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Send initial context message when the widget opens with context
  useEffect(() => {
    if (isOpen && assistantInitialContext && !contextSentRef.current) {
      contextSentRef.current = true;
      // Clear existing conversation and send context as first message
      clearMessages();
      sendMessage(assistantInitialContext);
      clearAssistantContext();
    }
    if (!assistantInitialContext) {
      contextSentRef.current = false;
    }
  }, [isOpen, assistantInitialContext, sendMessage, clearMessages, clearAssistantContext]);

  const handleSend = () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isSending) return;
    sendMessage(trimmed);
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className={`fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-105 ${
          isOpen
            ? "bg-cf-bg-tertiary border border-cf-border text-cf-text-muted"
            : "bg-cf-accent-blue text-white"
        }`}
        title="Dashboard Assistant"
      >
        {isOpen ? (
          /* X icon */
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="4" y1="4" x2="14" y2="14" />
            <line x1="14" y1="4" x2="4" y2="14" />
          </svg>
        ) : (
          /* Clawforce icon - chat bubble with claw */
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <path
              d="M11 2C5.48 2 1 5.58 1 10c0 2.39 1.33 4.53 3.41 5.97L3 20l4.34-2.17C8.51 18.27 9.73 18.5 11 18.5c5.52 0 10-3.58 10-8S16.52 2 11 2z"
              fill="currentColor"
              opacity="0.9"
            />
            <text x="7" y="13" fontSize="8" fill="white" fontWeight="bold">
              CF
            </text>
          </svg>
        )}
      </button>

      {/* Chat panel */}
      {isOpen && (
        <div
          className="fixed bottom-20 right-6 z-50 flex flex-col bg-cf-bg-primary border border-cf-border rounded-xl shadow-2xl overflow-hidden"
          style={{ width: 400, height: 500 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-cf-border bg-cf-bg-secondary">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-cf-accent-blue/20 flex items-center justify-center">
                <span className="text-xxs font-bold text-cf-accent-blue">CF</span>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-cf-text-primary">
                  Dashboard Assistant
                </h3>
                <p className="text-xxs text-cf-text-muted">
                  {isStreaming ? "Typing..." : "Ready to help"}
                </p>
              </div>
            </div>
            <button
              onClick={clearMessages}
              className="text-xxs text-cf-text-muted hover:text-cf-text-secondary transition-colors"
              title="Clear conversation"
            >
              Clear
            </button>
          </div>

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto py-2">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center px-6">
                <div className="w-10 h-10 rounded-full bg-cf-accent-blue/10 flex items-center justify-center mb-3">
                  <span className="text-sm font-bold text-cf-accent-blue">CF</span>
                </div>
                <p className="text-xs text-cf-text-secondary font-medium mb-1">
                  Clawforce Assistant
                </p>
                <p className="text-xxs text-cf-text-muted leading-relaxed">
                  Ask me to check agent status, review budgets, reassign tasks, search audit logs,
                  or manage your workforce.
                </p>
              </div>
            )}
            {messages.map((msg) => (
              <AssistantBubble key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t border-cf-border bg-cf-bg-secondary px-3 py-2.5">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask the assistant..."
                disabled={isSending}
                rows={1}
                className="flex-1 bg-cf-bg-tertiary border border-cf-border rounded-lg px-3 py-2 text-xs text-cf-text-primary placeholder:text-cf-text-muted resize-none focus:outline-none focus:border-cf-accent-blue transition-colors min-h-[36px] max-h-[80px]"
              />
              <button
                onClick={handleSend}
                disabled={!inputValue.trim() || isSending}
                className="px-3 py-2 bg-cf-accent-blue text-white text-xs font-semibold rounded-lg hover:bg-cf-accent-blue/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {isSending ? "..." : "Send"}
              </button>
            </div>
            <p className="text-xxs text-cf-text-muted mt-1">
              Enter to send, Shift+Enter for newline
            </p>
          </div>
        </div>
      )}
    </>
  );
}
