import type {
  GenerateRequest,
  ModelResponse,
  PowerSourceAdapter,
  ProviderConfig,
} from "../types.js";
import { postJson, resolveApiKey } from "./base.js";

interface AnthropicMessagesResponse {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Adapter for the Anthropic Messages API (Claude models).
 */
export class AnthropicAdapter implements PowerSourceAdapter {
  readonly kind = "anthropic" as const;
  readonly model: string;
  private readonly baseURL: string;

  constructor(readonly id: string, private readonly config: ProviderConfig) {
    this.model = config.model;
    this.baseURL = (config.baseURL || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  }

  async generate(request: GenerateRequest): Promise<ModelResponse> {
    const apiKey = resolveApiKey(this.config, "ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error(`Missing API key for Anthropic provider '${this.id}'.`);
    }

    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

    const payload: Record<string, unknown> = {
      model: this.model,
      system: request.systemPrompt,
      messages,
      temperature: request.temperature ?? this.config.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096,
    };

    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const data = await postJson<AnthropicMessagesResponse>(
      `${this.baseURL}/messages`,
      payload,
      {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(this.config.headers || {}),
      },
      request.signal
    );

    const blocks = data.content || [];
    const textContent = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("");

    const toolCalls = blocks
      .filter((b) => b.type === "tool_use" && b.id && b.name)
      .map((b) => ({
        id: b.id!,
        name: b.name!,
        arguments: b.input || {},
      }));

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      provider: this.id,
      model: this.model,
      finishReason: data.stop_reason,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }
}
