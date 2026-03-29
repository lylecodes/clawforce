/**
 * Clawforce — Context source registry
 *
 * Decouples context source registration from resolution.
 * Sources register themselves via registerContextSource() and are
 * resolved at runtime through resolveRegisteredSource().
 */

import type { ContextSource } from "../types.js";
import type { AssemblerContext } from "./assembler.js";

export type ContextSourceResolver = (ctx: AssemblerContext, source: ContextSource) => string | null;

const registry = new Map<string, ContextSourceResolver>();

/**
 * Register a context source resolver by name.
 * Throws if a source with the same name is already registered.
 */
export function registerContextSource(name: string, resolver: ContextSourceResolver): void {
  if (registry.has(name)) {
    throw new Error(`Context source "${name}" is already registered`);
  }
  registry.set(name, resolver);
}

/**
 * Resolve a context source by name using the registry.
 * Returns null if no resolver is registered for the given name.
 */
export function resolveRegisteredSource(
  name: string,
  ctx: AssemblerContext,
  source: ContextSource,
): string | null {
  const resolver = registry.get(name);
  if (!resolver) return null;
  return resolver(ctx, source);
}

/**
 * Get the list of all registered source names.
 */
export function getRegisteredSources(): string[] {
  return [...registry.keys()];
}

/**
 * Clear the registry. Only used in tests.
 */
export function clearRegistryForTest(): void {
  registry.clear();
}
