/**
 * Lightweight, provider-agnostic LLM client for ghost turn triage.
 *
 * Detects the available provider from shared environment variables
 * (the same ones OpenClaw uses) and routes to the appropriate API.
 * No SDK dependency — raw fetch only.
 */

export type ProviderInfo = {
  provider: "anthropic" | "openai" | "gemini";
  apiKey: string;
  model: string;
  endpoint: string;
};

export type TriageResult = {
  search: boolean;
  queries: string[];
};

const DEFAULT_MODELS: Record<ProviderInfo["provider"], string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
};

const ENDPOINTS: Record<ProviderInfo["provider"], string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
};

/**
 * Detect which LLM provider is available from environment variables.
 * Returns null if no key is found (graceful degradation).
 */
export function resolveProvider(): ProviderInfo | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      provider: "anthropic",
      apiKey: anthropicKey,
      model: DEFAULT_MODELS.anthropic,
      endpoint: ENDPOINTS.anthropic,
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      model: DEFAULT_MODELS.openai,
      endpoint: ENDPOINTS.openai,
    };
  }

  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    return {
      provider: "gemini",
      apiKey: geminiKey,
      model: DEFAULT_MODELS.gemini,
      endpoint: ENDPOINTS.gemini,
    };
  }

  return null;
}

// ── Provider-specific request formatters ──

function buildAnthropicRequest(
  systemPrompt: string,
  userContent: string,
  model: string,
): { url: string; body: unknown; headers: Record<string, string>; authHeader: (key: string) => Record<string, string> } {
  return {
    url: ENDPOINTS.anthropic,
    body: {
      model,
      max_tokens: 200,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    },
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    authHeader: (key: string) => ({ "x-api-key": key }),
  };
}

function buildOpenAIRequest(
  systemPrompt: string,
  userContent: string,
  model: string,
): { url: string; body: unknown; headers: Record<string, string>; authHeader: (key: string) => Record<string, string> } {
  return {
    url: ENDPOINTS.openai,
    body: {
      model,
      max_tokens: 200,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    },
    headers: { "content-type": "application/json" },
    authHeader: (key: string) => ({ authorization: `Bearer ${key}` }),
  };
}

function buildGeminiRequest(
  systemPrompt: string,
  userContent: string,
  model: string,
): { url: string; body: unknown; headers: Record<string, string>; authHeader: (_key: string) => Record<string, string> } {
  return {
    url: `${ENDPOINTS.gemini}/${model}:generateContent`,
    body: {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: { maxOutputTokens: 200, temperature: 0 },
    },
    headers: { "content-type": "application/json" },
    authHeader: () => ({}), // Gemini uses query param for auth
  };
}

// ── Response extractors ──

function extractAnthropicText(data: unknown): string | null {
  const d = data as { content?: Array<{ type: string; text?: string }> };
  const block = d.content?.find((c) => c.type === "text");
  return block?.text ?? null;
}

function extractOpenAIText(data: unknown): string | null {
  const d = data as { choices?: Array<{ message?: { content?: string } }> };
  return d.choices?.[0]?.message?.content ?? null;
}

function extractGeminiText(data: unknown): string | null {
  const d = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return d.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
}

const TEXT_EXTRACTORS: Record<ProviderInfo["provider"], (data: unknown) => string | null> = {
  anthropic: extractAnthropicText,
  openai: extractOpenAIText,
  gemini: extractGeminiText,
};

/**
 * Make a single triage LLM call using the detected provider.
 * Returns parsed TriageResult or null on any failure.
 */
export async function callTriage(
  systemPrompt: string,
  userContent: string,
  opts: { provider?: ProviderInfo; timeoutMs?: number; model?: string } = {},
): Promise<TriageResult | null> {
  const provider = opts.provider ?? resolveProvider();
  if (!provider) return null;

  const model = opts.model ?? provider.model;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const builders = {
    anthropic: buildAnthropicRequest,
    openai: buildOpenAIRequest,
    gemini: buildGeminiRequest,
  };

  const req = builders[provider.provider](systemPrompt, userContent, model);

  // Gemini uses API key as query param
  let url = req.url;
  if (provider.provider === "gemini") {
    url += `?key=${provider.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...req.headers, ...req.authHeader(provider.apiKey) },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data: unknown = await response.json();
    const text = TEXT_EXTRACTORS[provider.provider](data);
    if (!text) return null;

    return parseTriageResponse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse the LLM's triage response text into a TriageResult.
 * Handles JSON wrapped in markdown code fences.
 */
export function parseTriageResponse(text: string): TriageResult | null {
  try {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    const parsed = JSON.parse(cleaned) as { search?: boolean; queries?: string[] };
    if (typeof parsed.search !== "boolean") return null;

    return {
      search: parsed.search,
      queries: Array.isArray(parsed.queries)
        ? parsed.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        : [],
    };
  } catch {
    return null;
  }
}
