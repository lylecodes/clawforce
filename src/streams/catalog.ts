/**
 * Clawforce — Stream Catalog
 *
 * Registry for all data streams (built-in context sources and user-defined custom streams).
 * Provides discoverability via listStreams() and parameter schema for validation.
 */

export type OutputTarget = "briefing" | "telegram" | "webhook" | "log";

export type ParamSchema = {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  description: string;
  default?: unknown;
  required?: boolean;
};

export type StreamDefinition = {
  name: string;
  description: string;
  params?: ParamSchema[];
  sampleOutput?: string;
  builtIn: boolean;
  outputTargets: OutputTarget[];
};

const catalog = new Map<string, StreamDefinition>();

export function registerStream(def: StreamDefinition): void {
  catalog.set(def.name, def);
}

export function getStream(name: string): StreamDefinition | undefined {
  return catalog.get(name);
}

export function listStreams(): StreamDefinition[] {
  return Array.from(catalog.values());
}

export function clearCatalog(): void {
  catalog.clear();
}

export function formatStreamCatalog(): string {
  const streams = listStreams();
  if (streams.length === 0) return "No streams registered.";

  const lines = [`## Available Streams (${streams.length})`, ""];
  for (const s of streams) {
    const tag = s.builtIn ? "built-in" : "custom";
    lines.push(`- **${s.name}** (${tag}): ${s.description}`);
    if (s.params && s.params.length > 0) {
      for (const p of s.params) {
        const req = p.required ? " (required)" : "";
        const def = p.default !== undefined ? ` [default: ${JSON.stringify(p.default)}]` : "";
        lines.push(`  - \`${p.name}\` (${p.type}${req}${def}): ${p.description}`);
      }
    }
  }
  return lines.join("\n");
}
