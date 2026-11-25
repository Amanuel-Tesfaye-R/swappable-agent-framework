/**
 * Core types for the Swappable Agent Framework (Power Source Principle).
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Records which cognitive power source generated this message. */
  generatedBy?: {
    provider: string;
    model: string;
    timestamp: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ProviderKind = "openai" | "anthropic" | "google" | "ollama" | "openai-compatible";

export interface ProviderConfig {
  kind: ProviderKind;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
}

export interface ContractPaths {
  identity?: string;
  soul?: string;
  system?: string;
  agents?: string;
  user?: string;
}

export interface LoadedContracts {
  identity?: string;
  soul?: string;
  system?: string;
  agents?: string;
  user?: string;
  custom?: Record<string, string>;
}

export interface AgentConfig {
  agent: {
    name: string;
    version?: string;
    activeProvider: string;
    fallbackOrder?: string[];
    antiBleedShield?: boolean;
    contracts?: ContractPaths;
    providers: Record<string, ProviderConfig>;
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelResponse {
  content: string;
  toolCalls?: ToolCall[];
  provider: string;
  model: string;
  usage?: TokenUsage;
  finishReason?: string;
}

export interface GenerateRequest {
  systemPrompt: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StreamChunk {
  type: "delta" | "tool_call" | "done";
  text?: string;
  toolCall?: ToolCall;
  response?: ModelResponse;
}

export interface PowerSourceAdapter {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly model: string;
  generate(request: GenerateRequest): Promise<ModelResponse>;
  stream?(request: GenerateRequest): AsyncIterable<StreamChunk>;
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>;
}

export interface SwapEvent {
  fromProvider: string;
  toProvider: string;
  reason?: string;
  timestamp: string;
  messageIndex: number;
}

export interface SessionState {
  sessionId: string;
  agentName: string;
  activeProvider: string;
  messages: Message[];
  swaps: SwapEvent[];
  totalUsage: TokenUsage;
  createdAt: string;
  updatedAt: string;
}
