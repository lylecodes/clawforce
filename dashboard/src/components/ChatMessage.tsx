import type { Message, MessageRole } from "../api/types";

type ChatMessageProps = {
  message: Message;
};

const ROLE_COLORS: Record<MessageRole, { bubble: string; name: string }> = {
  manager: {
    bubble: "bg-cf-accent-blue/10 border-cf-accent-blue/30",
    name: "text-cf-accent-blue",
  },
  employee: {
    bubble: "bg-cf-accent-green/10 border-cf-accent-green/30",
    name: "text-cf-accent-green",
  },
  user: {
    bubble: "bg-cf-accent-purple/10 border-cf-accent-purple/30",
    name: "text-cf-accent-purple",
  },
};

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";
  const colors = ROLE_COLORS[message.role] ?? ROLE_COLORS.employee;

  return (
    <div
      className={`flex gap-2.5 px-4 py-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
    >
      {/* Avatar */}
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center text-xxs font-bold shrink-0 border ${colors.bubble}`}
      >
        <span className={colors.name}>
          {message.from.charAt(0).toUpperCase()}
        </span>
      </div>

      {/* Bubble */}
      <div
        className={`max-w-[70%] ${isUser ? "items-end" : "items-start"}`}
      >
        {/* Name + time */}
        <div
          className={`flex items-center gap-2 mb-1 ${isUser ? "flex-row-reverse" : "flex-row"}`}
        >
          <span className={`text-xxs font-semibold ${colors.name}`}>
            {message.from}
          </span>
          <span className="text-xxs text-cf-text-muted">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>

        {/* Content */}
        <div
          className={`rounded-lg border px-3 py-2 text-xs text-cf-text-primary leading-relaxed ${colors.bubble}`}
        >
          {message.content.split("\n").map((line, i) => (
            <p key={i} className={i > 0 ? "mt-1" : ""}>
              {line}
            </p>
          ))}
        </div>

        {/* Attachments / linked task */}
        {message.linkedTaskId && (
          <div className="mt-1">
            <span className="text-xxs text-cf-accent-blue hover:underline cursor-pointer">
              Linked: {message.linkedTaskId}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
