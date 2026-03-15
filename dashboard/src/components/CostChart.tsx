import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { theme } from "../styles/theme";
import type { DailyCost } from "../api/types";

type CostChartProps = {
  data: DailyCost[];
};

export function CostChart({ data }: CostChartProps) {
  const today = new Date().toISOString().split("T")[0];

  const chartData = data.map((entry) => ({
    date: formatDateShort(entry.date),
    rawDate: entry.date,
    cost: entry.totalCents / 100,
  }));

  if (chartData.length === 0) {
    return (
      <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-cf-text-primary mb-4">
          Daily Cost
        </h3>
        <div className="flex items-center justify-center h-[200px]">
          <p className="text-cf-text-muted text-sm">No cost data available</p>
        </div>
      </div>
    );
  }

  // Week-over-week trend: compare last 7 days total to prior 7 days
  const totalRecent = chartData
    .slice(-7)
    .reduce((sum, d) => sum + d.cost, 0);
  const totalPrior = chartData
    .slice(-14, -7)
    .reduce((sum, d) => sum + d.cost, 0);
  const trend =
    totalPrior > 0
      ? ((totalRecent - totalPrior) / totalPrior) * 100
      : 0;
  const trendLabel =
    trend > 0
      ? `+${trend.toFixed(0)}% WoW`
      : trend < 0
        ? `${trend.toFixed(0)}% WoW`
        : "Flat WoW";
  const trendColor =
    trend > 10
      ? theme.colors.accent.red
      : trend < -10
        ? theme.colors.accent.green
        : theme.colors.text.secondary;

  // Find today's index for dashed reference line
  const todayIndex = chartData.findIndex((d) => d.rawDate === today);

  return (
    <div className="bg-cf-bg-secondary border border-cf-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-cf-text-primary">
          Daily Cost
        </h3>
        <span className="text-xxs font-mono" style={{ color: trendColor }}>
          {trendLabel}
        </span>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={theme.colors.border.muted}
            vertical={false}
          />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: theme.colors.text.muted }}
            axisLine={{ stroke: theme.colors.border.default }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: theme.colors.text.muted }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: theme.colors.bg.tertiary,
              border: `1px solid ${theme.colors.border.default}`,
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: theme.colors.text.primary }}
            itemStyle={{ color: theme.colors.accent.blue }}
            formatter={(value: number) => [`$${value.toFixed(2)}`, "Cost"]}
          />
          <Bar
            dataKey="cost"
            fill={theme.colors.accent.blue}
            radius={[3, 3, 0, 0]}
            maxBarSize={40}
          />
          {todayIndex >= 0 && (
            <ReferenceLine
              x={chartData[todayIndex].date}
              stroke={theme.colors.accent.orange}
              strokeDasharray="4 4"
              strokeWidth={1.5}
              label={{
                value: "Today",
                position: "top",
                fill: theme.colors.accent.orange,
                fontSize: 10,
              }}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
