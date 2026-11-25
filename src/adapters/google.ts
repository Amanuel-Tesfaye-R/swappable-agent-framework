import type {
  GenerateRequest,
  ModelResponse,
  PowerSourceAdapter,
  ProviderConfig,
} from "../types.js";
import { postJson, resolveApiKey } from "./base.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name: string; args?: Record<string, unknown> };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Adapter for the Google Gemini REST API.
 */
export class GoogleGeminiAdapter implements PowerSourceAdapter {
  readonly kind = "google" as const;
  readonly model: string;
  private readonly baseURL: string;

  constructor(readonly id: string, private readonly config: ProviderConfig) {
    this.model = config.model;
    this.baseURL = (
      config.baseURL || "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");
  }

  async generate(request: GenerateRequest): Promise<ModelResponse> {
    const apiKey = resolveApiKey(this.config, "GEMINI_API_KEY");
    if (!apiKey) {
      throw new Error(`Missing API key for Google Gemini provider '${this.id}'.`);
    }

    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const payload: Record<string, unknown> = {
      systemInstruction: {
        parts: [{ text: request.systemPrompt }],
      },
      contents,
      generationConfig: {
        temperature: request.temperature ?? this.config.temperature ?? 0.2,
        maxOutputTokens: request.maxTokens ?? this.config.maxTokens ?? 8192,
      },
    };

    if (request.tools && request.tools.length > 0) {
      payload.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const url = `${this.baseURL}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const data = await postJson<GeminiResponse>(
      url,
      payload,
      { ...(this.config.headers || {}) },
      request.signal
    );

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const textContent = parts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text!)
      .join("");

    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p, idx) => ({
        id: `gemini_tc_${idx}`,
        name: p.functionCall!.name,
        arguments: p.functionCall!.args || {},
      }));

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      provider: this.id,
      model: this.model,
      finishReason: candidate?.finishReason,
      usage: data.usageMetadata
        ? {
            inputTokens: data.usageMetadata.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: data.usageMetadata.totalTokenCount ?? 0,
          }
        : undefined,
    };
  }
}
