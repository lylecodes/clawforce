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

