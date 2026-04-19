import { describe, expect, it } from "vitest";

// Side-effect import triggers all registrations
import "../../src/context/register-sources.js";
import { CONTEXT_SOURCE_NAMES } from "../../src/context/catalog.js";
import { getRegisteredSources } from "../../src/context/registry.js";

describe("context source registry", () => {
  it("has all sources registered", () => {
    const registered = new Set(getRegisteredSources());
    const missing = CONTEXT_SOURCE_NAMES.filter((name) => !registered.has(name));
    expect(missing, `Missing registrations: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no extra sources registered beyond the known set", () => {
    const registered = getRegisteredSources();
    const known = new Set<string>(CONTEXT_SOURCE_NAMES);
    const extra = registered.filter((name) => !known.has(name));
    expect(extra, `Unexpected registrations: ${extra.join(", ")}`).toEqual([]);
  });

  it(`registers exactly ${CONTEXT_SOURCE_NAMES.length} sources`, () => {
    const registered = getRegisteredSources();
    expect(registered.length).toBe(CONTEXT_SOURCE_NAMES.length);
  });
});
