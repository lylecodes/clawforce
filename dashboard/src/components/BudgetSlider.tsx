import { useCallback, type ChangeEvent } from "react";

type BudgetSliderProps = {
  label: string;
  value: number;
  min?: number;
  max: number;
  step?: number;
  unit?: string;
  currentUtilization?: number;
  onChange: (value: number) => void;
};

export function BudgetSlider({
  label,
  value,
  min = 0,
  max,
  step = 1,
  unit = "",
  currentUtilization,
  onChange,
}: BudgetSliderProps) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      onChange(Number(e.target.value));
    },
    [onChange],
  );

  const utilPct =
    currentUtilization !== undefined && value > 0
      ? Math.min((currentUtilization / value) * 100, 100)
      : undefined;

  // Format value display
  const displayValue =
    unit === "$"
      ? `$${(value / 100).toFixed(2)}`
      : `${value.toLocaleString()}${unit ? ` ${unit}` : ""}`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xxs text-cf-text-secondary font-semibold">
          {label}
        </span>
        <span className="text-xs text-cf-text-primary font-mono font-semibold">
          {displayValue}
        </span>
      </div>

      {/* Slider track with utilization overlay */}
      <div className="relative">
        {/* Utilization overlay */}
        {utilPct !== undefined && (
          <div className="absolute top-0 left-0 h-2 rounded-full z-0 pointer-events-none">
            <div
              className={`h-full rounded-full ${
                utilPct > 90
                  ? "bg-cf-accent-red/30"
                  : utilPct > 70
                    ? "bg-cf-accent-orange/30"
                    : "bg-cf-accent-green/30"
              }`}
              style={{ width: `${utilPct}%` }}
            />
          </div>
        )}

        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleChange}
          className="w-full h-2 rounded-full appearance-none cursor-pointer bg-cf-bg-tertiary
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-cf-accent-blue
            [&::-webkit-slider-thumb]:border-2
            [&::-webkit-slider-thumb]:border-cf-bg-secondary
            [&::-webkit-slider-thumb]:cursor-grab
            [&::-webkit-slider-thumb]:active:cursor-grabbing
            [&::-webkit-slider-thumb]:hover:bg-cf-accent-blue/80
            [&::-webkit-slider-thumb]:transition-colors
          "
        />
      </div>

      {/* Min/max labels */}
      <div className="flex items-center justify-between">
        <span className="text-xxs text-cf-text-muted font-mono">
          {unit === "$" ? `$${(min / 100).toFixed(0)}` : min}
        </span>
        {utilPct !== undefined && (
          <span className="text-xxs text-cf-text-muted">
            {Math.round(utilPct)}% used
          </span>
        )}
        <span className="text-xxs text-cf-text-muted font-mono">
          {unit === "$" ? `$${(max / 100).toFixed(0)}` : max.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
