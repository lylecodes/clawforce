import { theme } from "../styles/theme";
import type { AgentTrustScore } from "../api/types";

type TrustBarsProps = {
  agents: AgentTrustScore[];
};

function scoreColor(score: number): string {
  if (score >= 80) return theme.colors.accent.green;
  if (score >= 50) return theme.colors.accent.orange;
  return theme.colors.accent.red;
}

function trendArrow(trend: "up" | "down" | "stable"): { symbol: string; color: string } {
  switch (trend) {
    case "up":
      return { symbol: "\u2191", color: theme.colors.accent.green };
    case "down":
      return { symbol: "\u2193", color: theme.colors.accent.red };
    case "stable":
      return { symbol: "\u2192", color: theme.colors.text.secondary };
  }
}

export function TrustBars({ agents }: TrustBarsProps) {
  if (agents.length === 0) {
    return (
      <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-cf-text-primary mb-4">
          Trust Scores
        </h3>
        <div className="flex items-center justify-center h-[200px]">
          <p className="text-cf-text-muted text-sm">No trust data available</p>
        </div>
      </div>
    );
  }

  // Sort by overall score descending
  const sorted = [...agents].sort((a, b) => b.overall - a.overall);

  return (
    <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-cf-text-primary">
          Trust Scores
        </h3>
        <span className="text-xxs text-cf-text-muted">
          {agents.length} agent{agents.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="space-y-3">
        {sorted.map((agent) => {
          const arrow = trendArrow(agent.trend);
          const barColor = scoreColor(agent.overall);

          return (
            <div key={agent.agentId}>
              {/* Agent label row */}
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-cf-text-primary font-medium truncate">
                  {agent.agentId}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    className="text-xs font-bold"
                    style={{ color: arrow.color }}
                  >
                    {arrow.symbol}
                  </span>
                  <span
                    className="text-xs font-mono font-bold"
                    style={{ color: barColor }}
                  >
                    {agent.overall}%
                  </span>
                </div>
              </div>

              {/* Horizontal bar */}
              <div className="h-2 bg-cf-bg-tertiary rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(agent.overall, 100)}%`,
                    backgroundColor: barColor,
                  }}
                />
              </div>

              {/* Category breakdown (compact) */}
              {agent.categories && typeof agent.categories === "object" && Object.keys(agent.categories).length > 0 && (
                <div className="flex gap-3 mt-1">
                  {Object.entries(agent.categories).map(([cat, score]) => {
                    const numScore = typeof score === "number" ? score : 0;
                    return (
                      <span
                        key={cat}
                        className="text-xxs text-cf-text-muted"
                      >
                        {cat}: <span className="font-mono" style={{ color: scoreColor(numScore) }}>{numScore}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
