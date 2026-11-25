import { compileContracts, loadContractsFromDisk } from "./contract-compiler.js";
import { SessionStore } from "./session-store.js";
import { AnthropicAdapter } from "./adapters/anthropic.js";
import { GoogleGeminiAdapter } from "./adapters/google.js";
import { OllamaAdapter } from "./adapters/ollama.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import type {
  AgentConfig,
  LoadedContracts,
  Message,
  ModelResponse,
  PowerSourceAdapter,
  ProviderConfig,
  ToolDefinition,
} from "./types.js";

export function createAdapter(id: string, config: ProviderConfig): PowerSourceAdapter {
  switch (config.kind) {
    case "openai":
    case "openai-compatible":
      return new OpenAIAdapter(id, config);
    case "anthropic":
      return new AnthropicAdapter(id, config);
    case "google":
      return new GoogleGeminiAdapter(id, config);
    case "ollama":
      return new OllamaAdapter(id, config);
    default:
      throw new Error(`Unsupported provider kind '${String(config.kind)}' for '${id}'.`);
  }
}

export interface RouterOptions {
  baseDir?: string;
  sessionStore?: SessionStore;
  contracts?: LoadedContracts;
  adapters?: Record<string, PowerSourceAdapter>;
}

/**
 * Orchestrates swappable LLM power sources around a persistent agent identity and session store.
 */
export class PowerSourceRouter {
  private readonly config: AgentConfig;
  private readonly contracts: LoadedContracts;
  private readonly adapters = new Map<string, PowerSourceAdapter>();
  private readonly sessions: SessionStore;
  private activeProviderId: string;

  constructor(config: AgentConfig, options: RouterOptions = {}) {
    this.config = config;
    this.activeProviderId = config.agent.activeProvider;
    this.sessions = options.sessionStore ?? new SessionStore();

    if (options.contracts) {
      this.contracts = options.contracts;
    } else if (config.agent.contracts) {
      this.contracts = loadContractsFromDisk(config.agent.contracts, options.baseDir);
    } else {
      this.contracts = {};
    }

    for (const [id, providerCfg] of Object.entries(config.agent.providers)) {
      this.adapters.set(id, options.adapters?.[id] ?? createAdapter(id, providerCfg));
    }

    if (options.adapters) {
      for (const [id, adapter] of Object.entries(options.adapters)) {
        this.adapters.set(id, adapter);
      }
    }

    if (!this.adapters.has(this.activeProviderId)) {
      throw new Error(`Configured activeProvider '${this.activeProviderId}' is not registered.`);
    }
  }

  getAgentName(): string {
    return this.config.agent.name;
  }

  getActiveProvider(): string {
    return this.activeProviderId;
  }

  listProviders(): Array<{ id: string; kind: string; model: string; active: boolean }> {
    return Array.from(this.adapters.values()).map((a) => ({
      id: a.id,
      kind: a.kind,
      model: a.model,
      active: a.id === this.activeProviderId,
    }));
  }

  registerAdapter(adapter: PowerSourceAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /**
   * Hot-swaps the active cognitive power source without resetting identity or session history.
   */
  swapProvider(targetProviderId: string, sessionId?: string, reason?: string): void {
    if (!this.adapters.has(targetProviderId)) {
      throw new Error(`Cannot swap: provider '${targetProviderId}' is not registered.`);
    }
    this.activeProviderId = targetProviderId;
    if (sessionId && this.sessions.get(sessionId)) {
      this.sessions.recordSwap(sessionId, targetProviderId, reason);
    }
  }

  compileSystemPrompt(extraInstructions?: string[]): string {
    return compileContracts(this.contracts, {
      agentName: this.config.agent.name,
      antiBleedShield: this.config.agent.antiBleedShield ?? true,
      extraInstructions,
    }).prompt;
  }

  /**
   * Dispatches a prompt through the active power source (with automatic fallback on error),
   * keeping conversation state intact in the session store.
   */
  async chat(
    sessionId: string,
    userInput: string,
    options: { tools?: ToolDefinition[]; extraInstructions?: string[]; signal?: AbortSignal } = {}
  ): Promise<ModelResponse> {
    const session = this.sessions.getOrCreate(
      sessionId,
      this.config.agent.name,
      this.activeProviderId
    );

    const userMsg: Message = { role: "user", content: userInput };
    this.sessions.appendMessage(sessionId, userMsg);

    const systemPrompt = this.compileSystemPrompt(options.extraInstructions);
    const candidateIds = this.buildCandidateOrder();
    const errors: string[] = [];

    for (const providerId of candidateIds) {
      const adapter = this.adapters.get(providerId);
      if (!adapter) continue;

      try {
        if (providerId !== this.activeProviderId) {
          this.swapProvider(providerId, sessionId, `Automatic fallback after prior failure`);
        }

        const response = await adapter.generate({
          systemPrompt,
          messages: session.messages,
          tools: options.tools,
          signal: options.signal,
        });

        const assistantMsg: Message = {
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
          generatedBy: {
            provider: response.provider,
            model: response.model,
            timestamp: new Date().toISOString(),
          },
        };

        this.sessions.appendMessage(sessionId, assistantMsg, response.usage);
        return response;
      } catch (err) {
        errors.push(`${providerId}: ${(err as Error).message}`);
      }
    }

    throw new Error(`All configured power sources failed:\n- ${errors.join("\n- ")}`);
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  private buildCandidateOrder(): string[] {
    const fallbacks = this.config.agent.fallbackOrder || [];
    const seen = new Set<string>([this.activeProviderId]);
    const order = [this.activeProviderId];
    for (const id of fallbacks) {
      if (!seen.has(id) && this.adapters.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    return order;
  }
}
