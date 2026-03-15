import { useState } from "react";
import type { TaskFilters } from "../hooks/useTasks";

type FilterBarProps = {
  filters: TaskFilters;
  onFiltersChange: (filters: TaskFilters) => void;
  onCreateTask: () => void;
  agents: string[];
  departments: string[];
};

const PRIORITY_OPTIONS = [
  { value: "", label: "All Priorities" },
  { value: "P0", label: "P0 - Critical" },
  { value: "P1", label: "P1 - High" },
  { value: "P2", label: "P2 - Medium" },
  { value: "P3", label: "P3 - Low" },
];

export function FilterBar({
  filters,
  onFiltersChange,
  onCreateTask,
  agents,
  departments,
}: FilterBarProps) {
  const [showInitiatives, setShowInitiatives] = useState(false);

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Initiative pills */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => onFiltersChange({ ...filters, initiative: undefined })}
          className={`text-xxs px-2.5 py-1 rounded-full border transition-colors ${
            !filters.initiative
              ? "bg-cf-accent-blue/15 text-cf-accent-blue border-cf-accent-blue/30"
              : "bg-cf-bg-tertiary text-cf-text-secondary border-cf-border hover:border-cf-text-muted"
          }`}
        >
          All
        </button>
        {departments.map((dept) => (
          <button
            key={dept}
            onClick={() =>
              onFiltersChange({
                ...filters,
                initiative: filters.initiative === dept ? undefined : dept,
              })
            }
            className={`text-xxs px-2.5 py-1 rounded-full border transition-colors ${
              filters.initiative === dept
                ? "bg-cf-accent-blue/15 text-cf-accent-blue border-cf-accent-blue/30"
                : "bg-cf-bg-tertiary text-cf-text-secondary border-cf-border hover:border-cf-text-muted"
            }`}
          >
            {dept}
          </button>
        ))}
        {departments.length > 5 && (
          <button
            onClick={() => setShowInitiatives(!showInitiatives)}
            className="text-xxs text-cf-text-muted hover:text-cf-text-secondary transition-colors"
          >
            {showInitiatives ? "less" : `+${departments.length - 5} more`}
          </button>
        )}
      </div>

      {/* Agent dropdown */}
      <select
        value={filters.assignee ?? ""}
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            assignee: e.target.value || undefined,
          })
        }
        className="text-xxs bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-cf-text-secondary focus:border-cf-accent-blue focus:outline-none appearance-none cursor-pointer min-w-[120px]"
      >
        <option value="">All Agents</option>
        {agents.map((agent) => (
          <option key={agent} value={agent}>
            {agent}
          </option>
        ))}
      </select>

      {/* Priority dropdown */}
      <select
        value={filters.priority ?? ""}
        onChange={(e) =>
          onFiltersChange({
            ...filters,
            priority: e.target.value || undefined,
          })
        }
        className="text-xxs bg-cf-bg-tertiary border border-cf-border rounded px-2 py-1.5 text-cf-text-secondary focus:border-cf-accent-blue focus:outline-none appearance-none cursor-pointer min-w-[120px]"
      >
        {PRIORITY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Create Task button */}
      <button
        onClick={onCreateTask}
        className="text-xs font-medium px-3 py-1.5 rounded bg-cf-accent-blue text-white hover:bg-cf-accent-blue/80 transition-colors"
      >
        + Create Task
      </button>
    </div>
  );
}
