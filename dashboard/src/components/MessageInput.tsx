import { useState, useCallback, type KeyboardEvent } from "react";

type MessageInputProps = {
  onSend: (content: string) => void;
  isSending?: boolean;
  placeholder?: string;
  disabled?: boolean;
};

export function MessageInput({
  onSend,
  isSending = false,
  placeholder = "Type a message...",
  disabled = false,
}: MessageInputProps) {
  const [value, setValue] = useState("");

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isSending || disabled) return;
    onSend(trimmed);
    setValue("");
  }, [value, onSend, isSending, disabled]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="border-t border-cf-border bg-cf-bg-secondary px-4 py-3">
      {/* Shortcut hints */}
      <div className="flex items-center gap-3 mb-2">
        <button
          className="text-xxs text-cf-text-muted hover:text-cf-accent-blue transition-colors"
          onClick={() => setValue((v) => v + "@")}
          title="Mention an agent"
        >
          @mention
        </button>
        <button
          className="text-xxs text-cf-text-muted hover:text-cf-accent-blue transition-colors"
          title="Attach a file"
        >
          attach
        </button>
        <button
          className="text-xxs text-cf-text-muted hover:text-cf-accent-blue transition-colors"
          onClick={() => setValue((v) => v + "[task:")}
          title="Link a task"
        >
          link-task
        </button>
      </div>

      {/* Input */}
      <div className="flex items-end gap-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isSending}
          rows={1}
          className="flex-1 bg-cf-bg-tertiary border border-cf-border rounded-lg px-3 py-2 text-xs text-cf-text-primary placeholder:text-cf-text-muted resize-none focus:outline-none focus:border-cf-accent-blue transition-colors min-h-[36px] max-h-[120px]"
          style={{ height: "auto" }}
        />
        <button
          onClick={handleSend}
          disabled={!value.trim() || isSending || disabled}
          className="px-3 py-2 bg-cf-accent-blue text-white text-xs font-semibold rounded-lg hover:bg-cf-accent-blue/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          {isSending ? "..." : "Send"}
        </button>
      </div>
      <p className="text-xxs text-cf-text-muted mt-1">
        Enter to send, Shift+Enter for newline
      </p>
    </div>
  );
}
