import type {
  GenerateRequest,
  ModelResponse,
  PowerSourceAdapter,
  ProviderConfig,
} from "../types.js";
import { postJson, resolveApiKey } from "./base.js";

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Adapter for OpenAI and any OpenAI-compatible endpoint (DeepSeek, Groq, vLLM, OpenRouter).
 */
export class OpenAIAdapter implements PowerSourceAdapter {
  readonly kind;
  readonly model: string;
  private readonly baseURL: string;

  constructor(readonly id: string, private readonly config: ProviderConfig) {
    this.kind = config.kind;
    this.model = config.model;
    this.baseURL = (config.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  async generate(request: GenerateRequest): Promise<ModelResponse> {
    const apiKey = resolveApiKey(this.config, "OPENAI_API_KEY");
    if (!apiKey && this.kind === "openai") {
      throw new Error(`Missing API key for OpenAI provider '${this.id}'.`);
    }

    const messages = [
      { role: "system", content: request.systemPrompt },
      ...request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
    ];

    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: request.temperature ?? this.config.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
    };

    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const headers: Record<string, string> = { ...(this.config.headers || {}) };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const data = await postJson<OpenAIChatCompletionResponse>(
      `${this.baseURL}/chat/completions`,
      payload,
      headers,
      request.signal
    );

    const choice = data.choices?.[0];
    const rawToolCalls = choice?.message?.tool_calls;

    return {
      content: choice?.message?.content || "",
      toolCalls: rawToolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || "{}"),
      })),
      provider: this.id,
      model: this.model,
      finishReason: choice?.finish_reason,
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }
}
