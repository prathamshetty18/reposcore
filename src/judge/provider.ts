/**
 * src/judge/provider.ts — Provider-agnostic OpenAI-compatible chat completions client
 */

export type AIProviderName = "groq" | "openrouter" | "ollama" | "custom";

export interface AIProviderPreset {
  baseUrl: string;
  defaultModel: string;
}

export const PROVIDER_PRESETS: Record<string, AIProviderPreset> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3",
  },
};

export interface AIProviderConfig {
  provider: AIProviderName;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export function isAIConfigured(
  env: NodeJS.ProcessEnv = process.env,
  userApiKey?: string
): boolean {
  const provider = (env.AI_PROVIDER || "").toLowerCase().trim();
  const apiKey = (userApiKey || env.AI_API_KEY || env.GEMINI_API_KEY || "").trim();

  if (provider === "ollama") {
    return true;
  }

  const baseUrl = (env.AI_BASE_URL || "").trim();
  if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) {
    return true;
  }

  return apiKey.length > 0;
}

export function resolveAIConfig(
  env: NodeJS.ProcessEnv = process.env,
  userApiKey?: string
): AIProviderConfig {
  const providerRaw = (env.AI_PROVIDER || "groq").toLowerCase().trim();
  const provider: AIProviderName =
    providerRaw in PROVIDER_PRESETS ? (providerRaw as AIProviderName) : "custom";

  const preset = PROVIDER_PRESETS[provider];
  const baseUrl = (env.AI_BASE_URL || preset?.baseUrl || "").trim().replace(/\/+$/, "");
  const model = env.AI_MODEL || env.GEMMA_MODEL || preset?.defaultModel || "llama-3.3-70b-versatile";
  const apiKey = (userApiKey || env.AI_API_KEY || env.GEMINI_API_KEY || "").trim();

  if (!baseUrl) {
    throw new Error("AI_BASE_URL is required or a valid AI_PROVIDER preset must be set");
  }

  // Ollama or local URLs do not require an API key
  const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  if (provider !== "ollama" && !isLocal && !apiKey) {
    throw new Error(`AI_API_KEY is required for provider "${provider}"`);
  }

  return {
    provider,
    baseUrl,
    model,
    apiKey: apiKey || undefined,
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionClient {
  complete(messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<string>;
}

export function createChatCompletionClient(
  config: AIProviderConfig,
  fetchFn: typeof fetch = globalThis.fetch
): ChatCompletionClient {
  return {
    async complete(messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<string> {
      if (options?.signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
      }

      const endpoint = `${config.baseUrl}/chat/completions`;
      const body = JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const res = await fetchFn(endpoint, {
        method: "POST",
        headers,
        body,
        signal: options?.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        const err = Object.assign(new Error(`AI provider error (${res.status}): ${errorText}`), {
          status: res.status,
          statusCode: res.status,
        });
        throw err;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("Invalid response format from AI provider: missing content");
      }
      return content;
    },
  };
}
