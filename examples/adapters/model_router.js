/**
 * Swappable Model Router
 * Treats underlying LLMs as swappable cognitive power sources.
 */

export class ModelRouter {
  constructor(config) {
    this.config = config;
    this.activeProvider = config.agent.activeProvider;
  }

  setProvider(providerName) {
    if (!this.config.agent.providers[providerName]) {
      throw new Error(`Provider ${providerName} is not configured.`);
    }
    this.activeProvider = providerName;
  }

  getSystemPrompt(contracts) {
    // Compile persistent vessel identity before injecting into power source
    const segments = [];
    if (contracts.identity) segments.push(contracts.identity);
    if (contracts.soul) segments.push(contracts.soul);
    if (contracts.agents) segments.push(contracts.agents);
    if (contracts.user) segments.push(contracts.user);
    return segments.join("\n\n---\n\n");
  }

  async dispatchPrompt({ systemPrompt, messages, tools }) {
    const providerConfig = this.config.agent.providers[this.activeProvider];
    // Dispatch to selected power source (OpenAI, Anthropic, Google, Ollama)
    return {
      provider: this.activeProvider,
      model: providerConfig.model,
      status: "dispatched",
    };
  }
}
