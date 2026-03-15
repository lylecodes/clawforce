import { useState } from "react";
import type { ConfigChangePreview } from "../api/types";

type CostPreviewProps = {
  preview: ConfigChangePreview | null;
  isLoading?: boolean;
};

const RISK_STYLES: Record<string, { bg: string; text: string }> = {
  LOW: { bg: "bg-cf-risk-low/15", text: "text-cf-risk-low" },
  MEDIUM: { bg: "bg-cf-risk-medium/15", text: "text-cf-risk-medium" },
  HIGH: { bg: "bg-cf-risk-high/15", text: "text-cf-risk-high" },
};

export function CostPreview({ preview, isLoading }: CostPreviewProps) {
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <div className="bg-cf-bg-tertiary border border-cf-border rounded-lg p-3">
        <p className="text-xxs text-cf-text-muted animate-pulse">
          Calculating impact...
        </p>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="bg-cf-bg-tertiary border border-cf-border rounded-lg p-3">
        <p className="text-xxs text-cf-text-muted">
          Make changes to see cost impact preview
        </p>
      </div>
    );
  }

  const risk = RISK_STYLES[preview.risk] ?? RISK_STYLES.LOW;

  return (
    <div className="bg-cf-bg-tertiary border border-cf-border rounded-lg p-3 space-y-3">
      {/* Cost delta + risk badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xxs text-cf-text-muted uppercase tracking-wider font-semibold">
            Impact
          </span>
          <span
            className={`text-sm font-bold ${
              preview.costDirection === "cheaper"
                ? "text-cf-accent-green"
                : preview.costDirection === "more_expensive"
                  ? "text-cf-accent-red"
                  : "text-cf-text-secondary"
            }`}
          >
            {preview.costDelta}
          </span>
        </div>

        <span
          className={`text-xxs px-2 py-0.5 rounded font-bold ${risk.bg} ${risk.text}`}
          title={preview.riskExplanation}
        >
          {preview.risk}
        </span>
      </div>

      {/* Consequence */}
      <p className="text-xs text-cf-text-secondary leading-relaxed">
        {preview.consequence}
      </p>

      {/* Three-bucket breakdown (expandable) */}
      {preview.buckets && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xxs text-cf-accent-blue hover:underline"
          >
            {expanded ? "Hide" : "Show"} breakdown
          </button>

          {expanded && (
            <div className="mt-2 space-y-1.5">
              <BucketBar
                label="Management"
                value={preview.buckets.management}
                color="bg-cf-accent-blue"
              />
              <BucketBar
                label="Execution"
                value={preview.buckets.execution}
                color="bg-cf-accent-green"
              />
              <BucketBar
                label="Intelligence"
                value={preview.buckets.intelligence}
                color="bg-cf-accent-purple"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BucketBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xxs text-cf-text-muted w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-cf-bg-secondary rounded-full overflow-hidden">
        <div
          className={`h-full ${color} rounded-full transition-all`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
      <span className="text-xxs text-cf-text-secondary font-mono w-10 text-right">
        {value}%
      </span>
    </div>
  );
}
