type MetricCardProps = {
  label: string;
  value: string | number;
  subtitle?: string;
  /** 0-100 for progress bar display */
  progress?: number;
  /** Color variant based on threshold */
  variant?: "default" | "success" | "warning" | "danger";
};

const variantStyles = {
  default: {
    accent: "text-cf-accent-blue",
    bar: "bg-cf-accent-blue",
    border: "border-cf-accent-blue/20",
  },
  success: {
    accent: "text-cf-accent-green",
    bar: "bg-cf-accent-green",
    border: "border-cf-accent-green/20",
  },
  warning: {
    accent: "text-cf-accent-orange",
    bar: "bg-cf-accent-orange",
    border: "border-cf-accent-orange/20",
  },
  danger: {
    accent: "text-cf-accent-red",
    bar: "bg-cf-accent-red",
    border: "border-cf-accent-red/20",
  },
};

export function MetricCard({
  label,
  value,
  subtitle,
  progress,
  variant = "default",
}: MetricCardProps) {
  const styles = variantStyles[variant];

  return (
    <div
      className={`bg-cf-bg-secondary border ${styles.border} rounded-lg p-4 flex flex-col gap-2`}
    >
      <span className="text-xs text-cf-text-secondary uppercase tracking-wider font-medium">
        {label}
      </span>
      <span className={`text-2xl font-bold ${styles.accent}`}>{value}</span>
      {progress !== undefined && (
        <div className="h-1.5 bg-cf-bg-tertiary rounded-full overflow-hidden">
          <div
            className={`h-full ${styles.bar} rounded-full transition-all duration-500`}
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}
      {subtitle && (
        <span className="text-xxs text-cf-text-muted">{subtitle}</span>
      )}
    </div>
  );
}
