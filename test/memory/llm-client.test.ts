import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { resolveProvider, callTriage, parseTriageResponse } from "../../src/memory/llm-client.js";
import type { ProviderInfo } from "../../src/memory/llm-client.js";

describe("llm-client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("resolveProvider", () => {
    it("returns null when no keys are set", () => {
      expect(resolveProvider()).toBeNull();
    });

    it("detects Anthropic key first", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      process.env.OPENAI_API_KEY = "sk-openai-test";
      const result = resolveProvider();
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("anthropic");
      expect(result!.apiKey).toBe("sk-ant-test");
    });

    it("falls back to OpenAI", () => {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      const result = resolveProvider();
      expect(result!.provider).toBe("openai");
    });

    it("falls back to Gemini via GEMINI_API_KEY", () => {
      process.env.GEMINI_API_KEY = "gemini-test";
      const result = resolveProvider();
      expect(result!.provider).toBe("gemini");
    });

    it("falls back to Gemini via GOOGLE_API_KEY", () => {
      process.env.GOOGLE_API_KEY = "google-test";
      const result = resolveProvider();
      expect(result!.provider).toBe("gemini");
      expect(result!.apiKey).toBe("google-test");
    });

    it("includes correct default model and endpoint for each provider", () => {
      process.env.ANTHROPIC_API_KEY = "test";
      let r = resolveProvider()!;
      expect(r.model).toContain("claude");
      expect(r.endpoint).toContain("anthropic.com");

      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = "test";
      r = resolveProvider()!;
      expect(r.model).toContain("gpt");
      expect(r.endpoint).toContain("openai.com");

      delete process.env.OPENAI_API_KEY;
      process.env.GEMINI_API_KEY = "test";
      r = resolveProvider()!;
      expect(r.model).toContain("gemini");
      expect(r.endpoint).toContain("googleapis.com");
    });
  });

  describe("parseTriageResponse", () => {
    it("parses valid JSON response", () => {
      const result = parseTriageResponse('{ "search": true, "queries": ["test query"] }');
      expect(result).toEqual({ search: true, queries: ["test query"] });
    });

    it("parses JSON with code fences", () => {
      const result = parseTriageResponse('```json\n{ "search": true, "queries": ["q1", "q2"] }\n```');
      expect(result).toEqual({ search: true, queries: ["q1", "q2"] });
    });

    it("returns null for invalid JSON", () => {
      expect(parseTriageResponse("not json")).toBeNull();
    });

    it("returns null when search is not boolean", () => {
      expect(parseTriageResponse('{ "search": "yes", "queries": [] }')).toBeNull();
    });

    it("handles missing queries field gracefully", () => {
      const result = parseTriageResponse('{ "search": false }');
      expect(result).toEqual({ search: false, queries: [] });
    });

    it("filters out non-string queries", () => {
      const result = parseTriageResponse('{ "search": true, "queries": ["valid", 123, "", "also valid"] }');
      expect(result).toEqual({ search: true, queries: ["valid", "also valid"] });
    });

    it("strips whitespace-only queries", () => {
      const result = parseTriageResponse('{ "search": true, "queries": ["valid", "   ", "ok"] }');
      expect(result).toEqual({ search: true, queries: ["valid", "ok"] });
    });
  });

  describe("callTriage", () => {
    it("returns null when no provider is available", async () => {
      const result = await callTriage("system", "user");
      expect(result).toBeNull();
    });

    it("makes request to Anthropic API and parses response", async () => {
      const mockProvider: ProviderInfo = {
        provider: "anthropic",
        apiKey: "test-key",
        model: "claude-haiku-4-5-20251001",
        endpoint: "https://api.anthropic.com/v1/messages",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: '{ "search": true, "queries": ["test"] }' }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await callTriage("system prompt", "user content", { provider: mockProvider });
      expect(result).toEqual({ search: true, queries: ["test"] });

      // Verify the request was made correctly
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(opts.method).toBe("POST");
      expect(opts.headers["x-api-key"]).toBe("test-key");

      const body = JSON.parse(opts.body);
      expect(body.system).toBe("system prompt");
      expect(body.messages[0].content).toBe("user content");
      expect(body.max_tokens).toBe(200);
      expect(body.temperature).toBe(0);
    });

    it("makes request to OpenAI API format", async () => {
      const mockProvider: ProviderInfo = {
        provider: "openai",
        apiKey: "sk-test",
        model: "gpt-4o-mini",
        endpoint: "https://api.openai.com/v1/chat/completions",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{ "search": false, "queries": [] }' } }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await callTriage("sys", "usr", { provider: mockProvider });
      expect(result).toEqual({ search: false, queries: [] });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.authorization).toBe("Bearer sk-test");
    });

    it("makes request to Gemini API format with key as query param", async () => {
      const mockProvider: ProviderInfo = {
        provider: "gemini",
        apiKey: "gemini-key",
        model: "gemini-2.0-flash",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{ "search": true, "queries": ["q1"] }' }] } }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await callTriage("sys", "usr", { provider: mockProvider });
      expect(result).toEqual({ search: true, queries: ["q1"] });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("key=gemini-key");
      expect(url).toContain("gemini-2.0-flash:generateContent");
    });

    it("returns null on non-ok response", async () => {
      const mockProvider: ProviderInfo = {
        provider: "anthropic",
        apiKey: "test",
        model: "test",
        endpoint: "https://api.anthropic.com/v1/messages",
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
      const result = await callTriage("sys", "usr", { provider: mockProvider });
      expect(result).toBeNull();
    });

    it("returns null on network error", async () => {
      const mockProvider: ProviderInfo = {
        provider: "anthropic",
        apiKey: "test",
        model: "test",
        endpoint: "https://api.anthropic.com/v1/messages",
      };

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      const result = await callTriage("sys", "usr", { provider: mockProvider });
      expect(result).toBeNull();
    });

    it("respects model override", async () => {
      const mockProvider: ProviderInfo = {
        provider: "anthropic",
        apiKey: "test",
        model: "default-model",
        endpoint: "https://api.anthropic.com/v1/messages",
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: '{ "search": false, "queries": [] }' }],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await callTriage("sys", "usr", { provider: mockProvider, model: "override-model" });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("override-model");
    });
  });
});
