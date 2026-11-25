import type {
  GenerateRequest,
  ModelResponse,
  PowerSourceAdapter,
  ProviderConfig,
} from "../types.js";
import { postJson } from "./base.js";

interface OllamaChatResponse {
  message?: {
    role: string;
    content: string;
  };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Adapter for local Ollama model instances.
 */
export class OllamaAdapter implements PowerSourceAdapter {
  readonly kind = "ollama" as const;
  readonly model: string;
  private readonly baseURL: string;

  constructor(readonly id: string, private readonly config: ProviderConfig) {
    this.model = config.model;
    this.baseURL = (config.baseURL || "http://localhost:11434").replace(/\/+$/, "");
  }

  async generate(request: GenerateRequest): Promise<ModelResponse> {
    const messages = [
      { role: "system", content: request.systemPrompt },
      ...request.messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ];

    const payload = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: request.temperature ?? this.config.temperature ?? 0.2,
        num_predict: request.maxTokens ?? this.config.maxTokens ?? 4096,
      },
    };

    const data = await postJson<OllamaChatResponse>(
      `${this.baseURL}/api/chat`,
      payload,
      { ...(this.config.headers || {}) },
      request.signal
    );

    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;

    return {
      content: data.message?.content || "",
      provider: this.id,
      model: this.model,
      finishReason: data.done_reason,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${this.baseURL}/api/tags`);
      return { ok: res.ok, detail: res.ok ? "Ollama reachable" : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}
