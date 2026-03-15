/**
 * Clawforce theme tokens — GitHub-dark inspired palette.
 *
 * These are also defined in tailwind.config.ts as `cf-*` utility classes.
 * Use this file for programmatic access (e.g., Recharts chart colors).
 */
export const theme = {
  colors: {
    bg: {
      primary: "#0d1117",
      secondary: "#161b22",
      tertiary: "#21262d",
      hover: "#30363d",
    },
    border: {
      default: "#30363d",
      muted: "#21262d",
    },
    text: {
      primary: "#e6edf3",
      secondary: "#8b949e",
      muted: "#484f58",
    },
    accent: {
      blue: "#58a6ff",
      green: "#3fb950",
      orange: "#d29922",
      red: "#f85149",
      purple: "#bc8cff",
    },
    status: {
      active: "#3fb950",
      idle: "#8b949e",
      warning: "#d29922",
      disabled: "#f85149",
    },
    risk: {
      low: "#3fb950",
      medium: "#d29922",
      high: "#f85149",
    },
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 4, md: 6, lg: 8 },
  fontSize: {
    xs: "11px",
    sm: "12px",
    md: "14px",
    lg: "16px",
    xl: "20px",
    xxl: "24px",
  },
} as const;
