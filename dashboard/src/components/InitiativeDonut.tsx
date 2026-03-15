import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
} from "recharts";
import { theme } from "../styles/theme";
import type { DailyCost } from "../api/types";

type InitiativeDonutProps = {
  data: DailyCost[];
};

const COLORS = [
  theme.colors.accent.blue,
  theme.colors.accent.green,
  theme.colors.accent.orange,
  theme.colors.accent.purple,
  theme.colors.accent.red,
  "#79c0ff",
  "#56d364",
  "#e3b341",
  "#d2a8ff",
  "#ff7b72",
];

export function InitiativeDonut({ data }: InitiativeDonutProps) {
  // Aggregate cost by initiative across all days
  const initiativeTotals = new Map<string, number>();
  for (const day of data) {
    for (const [initiative, cents] of Object.entries(day.byInitiative)) {
      initiativeTotals.set(
        initiative,
        (initiativeTotals.get(initiative) ?? 0) + cents,
      );
    }
  }

  // Also sum any cost not attributed to a specific initiative
  const totalAllInitiatives = Array.from(initiativeTotals.values()).reduce(
    (s, v) => s + v,
    0,
  );
  const totalAllDays = data.reduce((s, d) => s + d.totalCents, 0);
  const unattributed = totalAllDays - totalAllInitiatives;
  if (unattributed > 0) {
    initiativeTotals.set("Other", unattributed);
  }

  const chartData = Array.from(initiativeTotals.entries())
    .map(([name, cents]) => ({
      name,
      value: cents / 100,
    }))
    .sort((a, b) => b.value - a.value);

  if (chartData.length === 0) {
    return (
      <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-cf-text-primary mb-4">
          Cost by Initiative
        </h3>
        <div className="flex items-center justify-center h-[200px]">
          <p className="text-cf-text-muted text-sm">No initiative data</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-cf-text-primary mb-4">
        Cost by Initiative
      </h3>

      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={2}
            dataKey="value"
          >
            {chartData.map((_entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={COLORS[index % COLORS.length]}
                stroke={theme.colors.bg.secondary}
                strokeWidth={2}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: theme.colors.bg.tertiary,
              border: `1px solid ${theme.colors.border.default}`,
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value: number) => [`$${value.toFixed(2)}`, "Cost"]}
          />
          <Legend
            verticalAlign="middle"
            align="right"
            layout="vertical"
            iconSize={8}
            iconType="circle"
            formatter={(value: string) => (
              <span style={{ color: theme.colors.text.secondary, fontSize: 11 }}>
                {value}
              </span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
