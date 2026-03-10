import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("../../src/diagnostics.js", () => ({
  emitDiagnosticEvent: vi.fn(),
  setDiagnosticEmitter: vi.fn(),
}));

import {
  shouldRunGhostTurn,
  buildTriagePrompt,
  serializeMessages,
  buildCronQuery,
  executeMemorySearch,
  formatMemoryResults,
  runGhostRecall,
  runCronRecall,
  clearCooldown,
  clearAllCooldowns,
  updateCooldown,
  isInCooldown,
  INTENSITY_PRESETS,
  type MemoryToolInstance,
  type GhostTurnOpts,
} from "../../src/memory/ghost-turn.js";
import type { ProviderInfo } from "../../src/memory/llm-client.js";

describe("ghost-turn", () => {
  beforeEach(() => {
    clearAllCooldowns();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearAllCooldowns();
  });

  describe("INTENSITY_PRESETS", () => {
    it("has three preset levels", () => {
      expect(Object.keys(INTENSITY_PRESETS)).toEqual(["low", "medium", "high"]);
    });

    it("low has longest cooldown and fewest searches", () => {
      expect(INTENSITY_PRESETS.low.cooldownMs).toBeGreaterThan(INTENSITY_PRESETS.medium.cooldownMs);
      expect(INTENSITY_PRESETS.low.maxSearches).toBeLessThan(INTENSITY_PRESETS.medium.maxSearches);
    });

    it("high has shortest cooldown and most searches", () => {
      expect(INTENSITY_PRESETS.high.cooldownMs).toBeLessThan(INTENSITY_PRESETS.medium.cooldownMs);
      expect(INTENSITY_PRESETS.high.maxSearches).toBeGreaterThan(INTENSITY_PRESETS.medium.maxSearches);
    });
  });

  describe("cooldown tracking", () => {
    it("isInCooldown returns false for unknown sessions", () => {
      expect(isInCooldown("unknown", 1000)).toBe(false);
    });

    it("isInCooldown returns true after updateCooldown within window", () => {
      updateCooldown("s1");
      expect(isInCooldown("s1", 60_000)).toBe(true);
    });

    it("clearCooldown removes cooldown", () => {
      updateCooldown("s1");
      clearCooldown("s1");
      expect(isInCooldown("s1", 60_000)).toBe(false);
    });
  });

  describe("shouldRunGhostTurn", () => {
    // We need an API key for resolveProvider to return non-null
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "test-key";
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("returns false when messageCount < minMessages", () => {
      expect(shouldRunGhostTurn({
        sessionKey: "s1",
        cooldownMs: 0,
        memoryMode: false,
        messageCount: 1,
        minMessages: 2,
      })).toBe(false);
    });

    it("returns true when messageCount >= minMessages and no cooldown", () => {
      expect(shouldRunGhostTurn({
        sessionKey: "s1",
        cooldownMs: 0,
        memoryMode: false,
        messageCount: 5,
        minMessages: 2,
      })).toBe(true);
    });

    it("returns false when in cooldown (non-memory mode)", () => {
      updateCooldown("s1");
      expect(shouldRunGhostTurn({
        sessionKey: "s1",
        cooldownMs: 60_000,
        memoryMode: false,
        messageCount: 5,
        minMessages: 2,
      })).toBe(false);
    });

    it("bypasses cooldown in memory mode", () => {
      updateCooldown("s1");
      expect(shouldRunGhostTurn({
        sessionKey: "s1",
        cooldownMs: 60_000,
        memoryMode: true,
        messageCount: 5,
        minMessages: 2,
      })).toBe(true);
    });

    it("returns false when no provider available", () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      expect(shouldRunGhostTurn({
        sessionKey: "s1",
        cooldownMs: 0,
        memoryMode: false,
        messageCount: 5,
        minMessages: 2,
      })).toBe(false);
    });
  });

  describe("buildTriagePrompt", () => {
    it("includes base prompt for all intensities", () => {
      for (const intensity of ["low", "medium", "high"] as const) {
        const prompt = buildTriagePrompt(intensity);
        expect(prompt).toContain("memory retrieval assistant");
        expect(prompt).toContain("JSON");
      }
    });

    it("low intensity is most restrictive", () => {
      const prompt = buildTriagePrompt("low");
      expect(prompt).toContain("EXPLICITLY");
    });

    it("high intensity encourages searching", () => {
      const prompt = buildTriagePrompt("high");
      expect(prompt).toContain("Err on the side of searching");
    });
  });

  describe("serializeMessages", () => {
    it("serializes messages as role: content pairs", () => {
      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      const result = serializeMessages(messages, 10);
      expect(result).toContain("user: hello");
      expect(result).toContain("assistant: hi there");
    });

    it("respects windowSize", () => {
      const messages = Array.from({ length: 20 }, (_, i) => ({
        role: "user",
        content: `msg ${i}`,
      }));
      const result = serializeMessages(messages, 3);
      expect(result).not.toContain("msg 0");
      expect(result).toContain("msg 17");
      expect(result).toContain("msg 18");
      expect(result).toContain("msg 19");
    });

    it("truncates long content to 500 chars", () => {
      const longContent = "x".repeat(1000);
      const messages = [{ role: "user", content: longContent }];
      const result = serializeMessages(messages, 10);
      expect(result.length).toBeLessThan(600);
    });

    it("handles array content (multi-part messages)", () => {
      const messages = [{
        role: "assistant",
        content: [
          { type: "text", text: "first part" },
          { type: "image", url: "image.png" },
          { type: "text", text: "second part" },
        ],
      }];
      const result = serializeMessages(messages, 10);
      expect(result).toContain("first part");
      expect(result).toContain("second part");
    });

    it("handles missing role or content", () => {
      const messages = [{ content: "no role" }, { role: "user" }];
      const result = serializeMessages(messages, 10);
      expect(result).toContain("unknown:");
      expect(result).toContain("user:");
    });
  });

  describe("buildCronQuery", () => {
    it("returns empty array for empty prompt", () => {
      expect(buildCronQuery("")).toEqual([]);
      expect(buildCronQuery("   ")).toEqual([]);
    });

    it("splits on sentence boundaries", () => {
      const result = buildCronQuery("Check the deployment logs. Alert if errors found. Report to team.");
      expect(result).toHaveLength(3);
      expect(result[0]).toContain("Check the deployment logs");
    });

    it("returns max 3 queries", () => {
      const prompt = "A long sentence one. B long sentence two. C long sentence three. D long sentence four. E long sentence five.";
      expect(buildCronQuery(prompt).length).toBeLessThanOrEqual(3);
    });

    it("filters out short sentences", () => {
      const result = buildCronQuery("OK. Do something important here.");
      // "OK" is too short (< 10 chars)
      expect(result.every(q => q.length > 5)).toBe(true);
    });

    it("truncates individual queries to 100 chars", () => {
      const longSentence = "A".repeat(200) + ".";
      const result = buildCronQuery(longSentence);
      expect(result[0]!.length).toBeLessThanOrEqual(100);
    });
  });

  describe("executeMemorySearch", () => {
    it("calls tool.execute for each query and returns results", async () => {
      const tool: MemoryToolInstance = {
        execute: vi.fn()
          .mockResolvedValueOnce({ content: [{ type: "text", text: "result1" }] })
          .mockResolvedValueOnce({ content: [{ type: "text", text: "result2" }] }),
      };

      const results = await executeMemorySearch(["q1", "q2"], tool, 5);
      expect(results).toEqual(["result1", "result2"]);
      expect(tool.execute).toHaveBeenCalledTimes(2);
    });

    it("deduplicates results across queries", async () => {
      const tool: MemoryToolInstance = {
        execute: vi.fn()
          .mockResolvedValueOnce({ content: [{ type: "text", text: "same result" }] })
          .mockResolvedValueOnce({ content: [{ type: "text", text: "same result" }] }),
      };

      const results = await executeMemorySearch(["q1", "q2"], tool, 5);
      expect(results).toEqual(["same result"]);
    });

    it("respects maxSearches limit", async () => {
      const tool: MemoryToolInstance = {
        execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "r" }] }),
      };

      await executeMemorySearch(["q1", "q2", "q3", "q4"], tool, 2);
      expect(tool.execute).toHaveBeenCalledTimes(2);
    });

    it("skips failed searches and continues", async () => {
      const tool: MemoryToolInstance = {
        execute: vi.fn()
          .mockRejectedValueOnce(new Error("timeout"))
          .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] }),
      };

      const results = await executeMemorySearch(["q1", "q2"], tool, 5);
      expect(results).toEqual(["ok"]);
    });

    it("passes correct params to tool.execute", async () => {
      const tool: MemoryToolInstance = {
        execute: vi.fn().mockResolvedValue({ content: [] }),
      };

      await executeMemorySearch(["my query"], tool, 5);
      const [, params] = tool.execute.mock.calls[0] as [string, Record<string, unknown>];
      expect(params.action).toBe("search");
      expect(params.query).toBe("my query");
      expect(params.maxResults).toBe(3);
    });
  });

  describe("formatMemoryResults", () => {
    it("returns null for empty results", () => {
      expect(formatMemoryResults([], 4000, false, [])).toBeNull();
    });

    it("formats results as Recalled Memory section", () => {
      const result = formatMemoryResults(["fact 1", "fact 2"], 4000, false, []);
      expect(result).toContain("## Recalled Memory");
      expect(result).toContain("fact 1");
      expect(result).toContain("fact 2");
    });

    it("truncates when exceeding maxChars", () => {
      const longResult = "x".repeat(5000);
      const result = formatMemoryResults([longResult], 100, false, []);
      expect(result!.length).toBeLessThan(200);
      expect(result).toContain("(truncated)");
    });

    it("includes debug comment when debug is true", () => {
      const result = formatMemoryResults(["data"], 4000, true, ["q1", "q2"]);
      expect(result).toContain("<!-- Ghost recall");
      expect(result).toContain("q1");
      expect(result).toContain("q2");
      expect(result).toContain("1 results");
    });

    it("omits debug comment when debug is false", () => {
      const result = formatMemoryResults(["data"], 4000, false, ["q1"]);
      expect(result).not.toContain("<!--");
    });
  });

  describe("runCronRecall", () => {
    it("returns null when tool is null", async () => {
      const result = await runCronRecall("test prompt", null, {
        maxSearches: 3,
        maxInjectedChars: 4000,
        debug: false,
        sessionKey: "s1",
      });
      expect(result).toBeNull();
    });

    it("returns null for empty prompt", async () => {
      const tool: MemoryToolInstance = {
        execute: vi.fn().mockResolvedValue({ content: [] }),
      };
      const result = await runCronRecall("", tool, {
        maxSearches: 3,
        maxInjectedChars: 4000,
        debug: false,
        sessionKey: "s1",
      });
      expect(result).toBeNull();
    });

    it("extracts queries from prompt and searches memory", async () => {
      const tool: MemoryToolInstance = {
        execute: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "Relevant memory data" }],
        }),
      };
      const result = await runCronRecall(
        "Check the deployment logs for errors. Report any failures to the team.",
        tool,
        { maxSearches: 3, maxInjectedChars: 4000, debug: false, sessionKey: "s1" },
      );
      expect(result).toContain("Recalled Memory");
      expect(result).toContain("Relevant memory data");
      expect(tool.execute).toHaveBeenCalled();
    });
  });

  describe("runGhostRecall", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "test-key";
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    const defaultOpts: GhostTurnOpts = {
      sessionKey: "test-session",
      intensity: "medium",
      memoryMode: false,
      windowSize: 10,
      maxInjectedChars: 4000,
      maxSearches: 3,
      debug: false,
    };

    it("returns null when tool is null", async () => {
      const result = await runGhostRecall([{ role: "user", content: "hi" }], null, defaultOpts);
      expect(result).toBeNull();
    });

    it("returns null when gating fails (< 2 messages)", async () => {
      const tool: MemoryToolInstance = {
        execute: vi.fn(),
      };
      const result = await runGhostRecall(
        [{ role: "user", content: "hi" }],
        tool,
        defaultOpts,
      );
      expect(result).toBeNull();
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it("runs full pipeline with mocked triage and search", async () => {
      // Mock the fetch for triage LLM call
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: '{ "search": true, "queries": ["project Alpha"] }' }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tool: MemoryToolInstance = {
        execute: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "Alpha is a web app project started in Jan." }],
        }),
      };

      const messages = [
        { role: "user", content: "What's the status of project Alpha?" },
        { role: "assistant", content: "Let me check on that." },
        { role: "user", content: "Also check the timeline." },
      ];

      const result = await runGhostRecall(messages, tool, defaultOpts);
      expect(result).toContain("Recalled Memory");
      expect(result).toContain("Alpha is a web app");
      expect(tool.execute).toHaveBeenCalled();
    });

    it("returns null when triage says no search needed", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: '{ "search": false, "queries": [] }' }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tool: MemoryToolInstance = { execute: vi.fn() };
      const messages = [
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
      ];

      const result = await runGhostRecall(messages, tool, defaultOpts);
      expect(result).toBeNull();
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it("uses high intensity when memoryMode is true", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: '{ "search": true, "queries": ["test"] }' }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const tool: MemoryToolInstance = {
        execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "data" }] }),
      };

      const messages = [
        { role: "user", content: "tell me about X" },
        { role: "assistant", content: "let me check" },
      ];

      // Memory mode: should bypass cooldown
      updateCooldown("mem-test");
      await runGhostRecall(messages, tool, {
        ...defaultOpts,
        sessionKey: "mem-test",
        memoryMode: true,
      });

      // Should have run despite cooldown
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});
