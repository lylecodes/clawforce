import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        cf: {
          bg: {
            primary: "#0d1117",
            secondary: "#161b22",
            tertiary: "#21262d",
            hover: "#30363d",
          },
          border: {
            DEFAULT: "#30363d",
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
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Noto Sans",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        xxs: "11px",
      },
    },
  },
  plugins: [],
} satisfies Config;
