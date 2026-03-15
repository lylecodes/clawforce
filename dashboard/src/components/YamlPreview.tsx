import { useMemo } from "react";

type YamlPreviewProps = {
  current: unknown;
  proposed: unknown;
  title?: string;
};

/**
 * Simple YAML-like diff view. Shows added lines in green, removed in red.
 * Not a real YAML parser — serializes to a readable key-value format for preview.
 */
export function YamlPreview({
  current,
  proposed,
  title = "Config Preview",
}: YamlPreviewProps) {
  const { lines } = useMemo(() => {
    const currentYaml = toYamlLines(current);
    const proposedYaml = toYamlLines(proposed);
    return computeDiff(currentYaml, proposedYaml);
  }, [current, proposed]);

  if (lines.length === 0) {
    return (
      <div className="bg-cf-bg-tertiary border border-cf-border rounded-lg p-3">
        <p className="text-xxs text-cf-text-muted font-semibold uppercase tracking-wider mb-2">
          {title}
        </p>
        <p className="text-xxs text-cf-text-muted font-mono">
          No changes from defaults
        </p>
      </div>
    );
  }

  return (
    <div className="bg-cf-bg-tertiary border border-cf-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-cf-border-muted">
        <p className="text-xxs text-cf-text-muted font-semibold uppercase tracking-wider">
          {title}
        </p>
      </div>
      <div className="overflow-x-auto">
        <pre className="text-xxs font-mono leading-relaxed p-3">
          {lines.map((line, i) => (
            <div
              key={i}
              className={`px-1 ${
                line.type === "add"
                  ? "bg-cf-accent-green/10 text-cf-accent-green"
                  : line.type === "remove"
                    ? "bg-cf-accent-red/10 text-cf-accent-red"
                    : "text-cf-text-secondary"
              }`}
            >
              <span className="select-none opacity-50 mr-2">
                {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              </span>
              {line.text}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

type DiffLine = {
  type: "context" | "add" | "remove";
  text: string;
};

function toYamlLines(obj: unknown, indent = 0): string[] {
  if (obj === null || obj === undefined) return [];

  const prefix = "  ".repeat(indent);

  if (typeof obj !== "object") {
    return [`${prefix}${String(obj)}`];
  }

  if (Array.isArray(obj)) {
    return obj.flatMap((item, _i) => {
      if (typeof item === "object" && item !== null) {
        const inner = toYamlLines(item, indent + 1);
        return [`${prefix}-`, ...inner];
      }
      return [`${prefix}- ${String(item)}`];
    });
  }

  const entries = Object.entries(obj as Record<string, unknown>);
  return entries.flatMap(([key, value]) => {
    if (value === null || value === undefined) {
      return [`${prefix}${key}:`];
    }
    if (typeof value === "object") {
      return [`${prefix}${key}:`, ...toYamlLines(value, indent + 1)];
    }
    return [`${prefix}${key}: ${String(value)}`];
  });
}

function computeDiff(
  currentLines: string[],
  proposedLines: string[],
): { lines: DiffLine[] } {
  const currentSet = new Set(currentLines);
  const proposedSet = new Set(proposedLines);

  const result: DiffLine[] = [];

  // Show removed lines
  for (const line of currentLines) {
    if (!proposedSet.has(line)) {
      result.push({ type: "remove", text: line });
    }
  }

  // Show added lines
  for (const line of proposedLines) {
    if (!currentSet.has(line)) {
      result.push({ type: "add", text: line });
    } else {
      result.push({ type: "context", text: line });
    }
  }

  return { lines: result };
}
