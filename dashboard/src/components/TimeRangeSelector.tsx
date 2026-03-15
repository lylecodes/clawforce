export type TimeRange = "today" | "7d" | "30d" | "custom";

type TimeRangeSelectorProps = {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
};

const options: { value: TimeRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 Days" },
  { value: "30d", label: "30 Days" },
  { value: "custom", label: "Custom" },
];

export function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  return (
    <div className="flex gap-1 bg-cf-bg-tertiary rounded-lg p-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`
            px-3 py-1.5 text-xs rounded-md transition-colors font-medium
            ${
              value === opt.value
                ? "bg-cf-bg-secondary text-cf-text-primary shadow-sm"
                : "text-cf-text-secondary hover:text-cf-text-primary"
            }
          `}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Convert TimeRange to a days-back number for API queries. */
export function timeRangeToDays(range: TimeRange): number {
  switch (range) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "custom":
      return 30; // fallback
  }
}
