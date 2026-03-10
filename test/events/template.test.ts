import { describe, expect, it } from "vitest";
import { interpolate, interpolateRecord, type TemplateContext } from "../../src/events/template.js";

describe("events/template", () => {
  const ctx: TemplateContext = {
    event: { id: "evt-1", type: "deploy_done", source: "webhook", projectId: "proj-1" },
    payload: { runId: 42, branch: "main", nested: { field: "deep" }, isNull: null },
  };

  describe("interpolate", () => {
    it("resolves {{payload.field}}", () => {
      expect(interpolate("Run {{payload.runId}} on {{payload.branch}}", ctx)).toBe("Run 42 on main");
    });

    it("resolves {{event.*}} fields", () => {
      expect(interpolate("Type: {{event.type}}, Project: {{event.projectId}}", ctx))
        .toBe("Type: deploy_done, Project: proj-1");
    });

    it("resolves {{event.id}} and {{event.source}}", () => {
      expect(interpolate("{{event.id}} from {{event.source}}", ctx))
        .toBe("evt-1 from webhook");
    });

    it("resolves nested paths", () => {
      expect(interpolate("value: {{payload.nested.field}}", ctx)).toBe("value: deep");
    });

    it("returns empty string for unknown paths", () => {
      expect(interpolate("missing: {{payload.nope}}", ctx)).toBe("missing: ");
    });

    it("returns empty string for null/undefined values", () => {
      expect(interpolate("null: {{payload.isNull}}", ctx)).toBe("null: ");
    });

    it("JSON.stringifies object values", () => {
      expect(interpolate("obj: {{payload.nested}}", ctx)).toBe('obj: {"field":"deep"}');
    });

    it("returns template unchanged when no {{}} present", () => {
      expect(interpolate("no placeholders here", ctx)).toBe("no placeholders here");
    });

    it("handles whitespace inside braces", () => {
      expect(interpolate("{{ payload.runId }}", ctx)).toBe("42");
    });

    it("handles empty template", () => {
      expect(interpolate("", ctx)).toBe("");
    });
  });

  describe("interpolateRecord", () => {
    it("applies interpolation to all record values", () => {
      const result = interpolateRecord(
        { key1: "{{payload.runId}}", key2: "branch: {{payload.branch}}", key3: "static" },
        ctx,
      );
      expect(result).toEqual({ key1: "42", key2: "branch: main", key3: "static" });
    });

    it("returns empty record for empty input", () => {
      expect(interpolateRecord({}, ctx)).toEqual({});
    });
  });
});
