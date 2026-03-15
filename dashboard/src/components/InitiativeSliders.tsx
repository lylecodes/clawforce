import { useCallback } from "react";

type InitiativeSlidersProps = {
  initiatives: Record<string, number>;
  onChange: (initiatives: Record<string, number>) => void;
};

const COLORS = [
  "bg-cf-accent-blue",
  "bg-cf-accent-green",
  "bg-cf-accent-orange",
  "bg-cf-accent-red",
  "bg-cf-accent-purple",
];

export function InitiativeSliders({
  initiatives,
  onChange,
}: InitiativeSlidersProps) {
  const entries = Object.entries(initiatives);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);

  const handleChange = useCallback(
    (key: string, newValue: number) => {
      onChange({ ...initiatives, [key]: newValue });
    },
    [initiatives, onChange],
  );

  return (
    <div className="space-y-4">
      {/* Stacked bar visualization */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xxs text-cf-text-muted font-semibold uppercase tracking-wider">
            Allocation Distribution
          </span>
          <span
            className={`text-xxs font-mono ${
              total === 100
                ? "text-cf-accent-green"
                : total > 100
                  ? "text-cf-accent-red"
                  : "text-cf-text-muted"
            }`}
          >
            {total}% / 100%
          </span>
        </div>

        <div className="h-4 rounded-full overflow-hidden flex bg-cf-bg-tertiary">
          {entries.map(([key, value], i) => (
            <div
              key={key}
              className={`${COLORS[i % COLORS.length]} transition-all duration-300`}
              style={{ width: `${value}%` }}
              title={`${key}: ${value}%`}
            />
          ))}
        </div>
      </div>

      {/* Individual sliders */}
      <div className="space-y-3">
        {entries.map(([key, value], i) => (
          <div key={key}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span
                  className={`w-2.5 h-2.5 rounded-sm ${COLORS[i % COLORS.length]}`}
                />
                <span className="text-xs text-cf-text-primary font-medium">
                  {key}
                </span>
              </div>
              <span className="text-xxs text-cf-text-secondary font-mono">
                {value}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={value}
              onChange={(e) => handleChange(key, Number(e.target.value))}
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-cf-bg-tertiary
                [&::-webkit-slider-thumb]:appearance-none
                [&::-webkit-slider-thumb]:w-3.5
                [&::-webkit-slider-thumb]:h-3.5
                [&::-webkit-slider-thumb]:rounded-full
                [&::-webkit-slider-thumb]:bg-cf-accent-blue
                [&::-webkit-slider-thumb]:border-2
                [&::-webkit-slider-thumb]:border-cf-bg-secondary
                [&::-webkit-slider-thumb]:cursor-grab
              "
            />
          </div>
        ))}
      </div>

      {/* Legend */}
      {entries.length === 0 && (
        <p className="text-xxs text-cf-text-muted text-center py-2">
          No initiatives configured. Add initiatives in the Initiatives tab.
        </p>
      )}
    </div>
  );
}
