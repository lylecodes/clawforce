import type { Meeting } from "../api/types";

type MeetingHeaderProps = {
  meeting: Meeting;
  onEnd: () => void;
  isEnding?: boolean;
};

const PARTICIPANT_COLORS = [
  "border-cf-accent-blue",
  "border-cf-accent-green",
  "border-cf-accent-orange",
  "border-cf-accent-red",
  "border-cf-accent-purple",
];

function formatDuration(startedAt: number): string {
  const elapsed = Date.now() - startedAt;
  const mins = Math.floor(elapsed / 60_000);
  const secs = Math.floor((elapsed % 60_000) / 1_000);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function MeetingHeader({ meeting, onEnd, isEnding }: MeetingHeaderProps) {
  const isActive = meeting.status === "active";

  return (
    <div className="bg-cf-bg-tertiary border-b border-cf-border px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Live indicator */}
          {isActive && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cf-accent-blue animate-pulse" />
              <span className="text-xxs font-bold text-cf-accent-blue uppercase tracking-wider">
                Live
              </span>
            </div>
          )}

          {/* Topic */}
          <span className="text-sm font-semibold text-cf-text-primary">
            {meeting.topic ?? "Meeting"}
          </span>

          {/* Duration */}
          <span className="text-xxs text-cf-text-muted font-mono">
            {formatDuration(meeting.startedAt)}
          </span>
        </div>

        {/* End button */}
        {isActive && (
          <button
            onClick={onEnd}
            disabled={isEnding}
            className="px-3 py-1.5 bg-cf-accent-red/15 text-cf-accent-red text-xxs font-semibold rounded hover:bg-cf-accent-red/25 disabled:opacity-40 transition-colors"
          >
            {isEnding ? "Ending..." : "End Meeting"}
          </button>
        )}
      </div>

      {/* Participant avatars */}
      <div className="flex items-center gap-1 mt-2">
        {meeting.participants.map((p, i) => (
          <span
            key={p}
            className={`w-7 h-7 rounded-full bg-cf-bg-secondary border-2 ${PARTICIPANT_COLORS[i % PARTICIPANT_COLORS.length]} flex items-center justify-center text-xxs font-bold text-cf-text-secondary`}
            title={p}
          >
            {p.charAt(0).toUpperCase()}
          </span>
        ))}
        <span className="text-xxs text-cf-text-muted ml-2">
          {meeting.participants.length} participants
        </span>
      </div>
    </div>
  );
}
