import { useState, useMemo } from "react";
import type { Agent, AgentTrustScore } from "../api/types";

type PerformanceRow = {
  agentId: string;
  title?: string;
  tasksCompleted: number;
  compliancePct: number | null;
  totalCostCents: number;
  costPerTask: number;
};

type PerformanceTableProps = {
  agents: Agent[];
  trustScores?: AgentTrustScore[];
};

type SortKey = "agentId" | "tasksCompleted" | "compliancePct" | "totalCostCents" | "costPerTask";
type SortDir = "asc" | "desc";

const columns: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "agentId", label: "Agent", align: "left" },
  { key: "tasksCompleted", label: "Tasks", align: "right" },
  { key: "compliancePct", label: "Compliance %", align: "right" },
  { key: "totalCostCents", label: "Cost", align: "right" },
  { key: "costPerTask", label: "$/Task", align: "right" },
];

export function PerformanceTable({ agents, trustScores }: PerformanceTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("agentId");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const rows: PerformanceRow[] = useMemo(
    () => {
      const complianceMap: Record<string, number> = {};
      if (trustScores) {
        for (const ts of trustScores) {
          // Prefer the specific compliance category; fall back to overall trust score
          const raw = ts.categories?.compliance ?? ts.overall;
          if (raw != null) {
            complianceMap[ts.agentId] = Math.round(raw * 100);
          }
        }
      }
      return agents.map((a) => {
        const tasks = a.tasksCompleted ?? 0;
        const cost = a.totalCostCents ?? 0;
        return {
          agentId: a.id,
          title: a.title,
          tasksCompleted: tasks,
          compliancePct: complianceMap[a.id] ?? null,
          totalCostCents: cost,
          costPerTask: tasks > 0 ? cost / 100 / tasks : 0,
        };
      });
    },
    [agents, trustScores],
  );

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc"
          ? av.localeCompare(bv)
          : bv.localeCompare(av);
      }
      const numA = Number(av);
      const numB = Number(bv);
      return sortDir === "asc" ? numA - numB : numB - numA;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " \u2191" : " \u2193";
  }

  if (agents.length === 0) {
    return (
      <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-cf-text-primary mb-4">
          Agent Performance
        </h3>
        <div className="flex items-center justify-center h-[200px]">
          <p className="text-cf-text-muted text-sm">No agents</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-cf-bg-secondary border border-cf-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-cf-border-muted">
        <h3 className="text-sm font-semibold text-cf-text-primary">
          Agent Performance
        </h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-cf-border-muted">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-2 font-medium text-cf-text-secondary cursor-pointer hover:text-cf-text-primary transition-colors select-none whitespace-nowrap ${
                    col.align === "right" ? "text-right" : "text-left"
                  }`}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  <span className="text-cf-accent-blue">{sortIndicator(col.key)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.agentId}
                className="border-b border-cf-border-muted last:border-0 hover:bg-cf-bg-tertiary/50 transition-colors"
              >
                <td className="px-4 py-2 text-cf-text-primary font-medium">
                  <div className="flex flex-col">
                    <span>{row.agentId}</span>
                    {row.title && (
                      <span className="text-cf-text-muted text-xs font-normal">
                        {row.title}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2 text-right text-cf-text-secondary font-mono">
                  {row.tasksCompleted}
                </td>
                <td className="px-4 py-2 text-right">
                  {row.compliancePct != null ? (
                    <span
                      className={`font-mono ${
                        row.compliancePct >= 90
                          ? "text-cf-accent-green"
                          : row.compliancePct >= 70
                            ? "text-cf-accent-orange"
                            : "text-cf-accent-red"
                      }`}
                    >
                      {row.compliancePct}%
                    </span>
                  ) : (
                    <span className="font-mono text-cf-text-muted">--</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right text-cf-text-secondary font-mono">
                  ${(row.totalCostCents / 100).toFixed(2)}
                </td>
                <td className="px-4 py-2 text-right text-cf-text-secondary font-mono">
                  ${row.costPerTask.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
