# Blueprint: LLM Integration

> How to connect a terminal AI tool to large language models - API layer, streaming, model selection, fallback, and token management.

---

## 1. Responsibility

The LLM Integration layer is the bridge between the application and one or more language model providers. It handles:

- Sending conversation history to the model
- Receiving streaming responses (text + tool calls)
- Managing API keys, endpoints, and authentication
- Selecting models based on capability, cost, or user preference
- Falling back when a provider fails
- Accounting for token usage and context window limits

---

## 2. Core Types

```typescript
// --- Message Types ---
interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;           // for tool call messages
    tool_call_id?: string;    // for tool result messages
}

interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;   // JSON string
    };
}

interface AssistantMessage extends Message {
    role: "assistant";
    tool_calls?: ToolCall[];
}

// --- Model Types ---
type ModelProvider = "openai" | "anthropic" | "google" | "ollama" | "custom";

interface ModelConfig {
    id: string;                  // e.g. "gpt-4o", "claude-3-opus"
    provider: ModelProvider;
    baseUrl: string;             // API endpoint
    apiKeyEnvVar: string;        // env var name, e.g. "OPENAI_API_KEY"
    maxTokens: number;
    contextWindow: number;       // total tokens the model supports
    supportsTools: boolean;
    supportsStreaming: boolean;
    costPer1kInput: number;      // in USD
    costPer1kOutput: number;
}

// --- Request Types ---
interface CompletionRequest {
    messages: Message[];
    model: ModelConfig;
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    onToken?: (token: string) => void;
    onToolCall?: (call: ToolCall) => void;
    signal?: AbortSignal;        // for cancellation
}

interface CompletionResult {
    message: AssistantMessage;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
    model: string;
    latencyMs: number;
}
```

---

## 3. Architecture

```
Application Layer (Session Manager)
    |
    v
+---------------------------+
|     LLM Router            |
|  - selects model          |
|  - manages fallback       |
|  - tracks usage/cost      |
+---------------------------+
    |
    v
+---------------------------+
|     Provider Adapters     |
|  +--------+  +---------+  |
|  | OpenAI |  | Anthropic|  |
|  +--------+  +---------+  |
|  +--------+  +---------+  |
|  | Ollama |  | Custom   |  |
|  +--------+  +---------+  |
+---------------------------+
    |
    v
+---------------------------+
|     HTTP Transport        |
|  - streaming SSE          |
|  - connection pool        |
|  - retry with backoff     |
+---------------------------+
```

---

## 4. Streaming Protocol

The model generates tokens one at a time. The application receives them as a stream and can:

1. **Render text progressively** in the TUI as it arrives
2. **Detect tool calls** mid-stream (OpenAI style: tool calls arrive as a single delta)
3. **Stop generation** when the user presses Ctrl+C

### Open AI API (SSE) Stream Format

```
event: message
data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}

event: message
data: {"id":"...","choices":[{"delta":{"content":" world"}}]}

event: message
data: {"id":"...","choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\"file\":\""}}]}}]}

event: done
data: [DONE]
```

### Implementation Pattern

```typescript
async function* streamCompletion(
    request: CompletionRequest
): AsyncGenerator<StreamEvent> {
    const url = `${request.model.baseUrl}/chat/completions`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${getApiKey(request.model)}`,
        },
        body: JSON.stringify({
            model: request.model.id,
            messages: request.messages,
            tools: request.tools,
            stream: true,
            temperature: request.temperature ?? 0.7,
        }),
        signal: request.signal,
    });

    if (!response.ok) {
        throw new ApiError(response.status, await response.text());
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") return;

            const event = JSON.parse(payload);
            yield parseStreamEvent(event);
        }
    }
}
```

---

## 5. Tool Call Handling

The model can request tool execution mid-generation. The protocol varies by provider:

### OpenAI-style (function calling)

```json
{
    "choices": [{
        "delta": {
            "tool_calls": [{
                "index": 0,
                "id": "call_xxx",
                "function": {
                    "name": "read_file",
                    "arguments": "{\"path\":\"..."
                }
            }]
        }
    }]
}
```

### Anthropic-style (tool_use blocks)

```json
{
    "content": [
        {"type": "text", "text": "Let me check..."},
        {"type": "tool_use", "id": "toolu_xxx", "name": "read_file", "input": {"path": "..."}}
    ],
    "stop_reason": "tool_use"
}
```

### Flow

```
Model generates partial text
    |
Model emits tool call(s)
    |
Runtime intercepts, does NOT render the tool call JSON
    |
Runtime executes each tool (see Tool Sandbox blueprint)
    |
Runtime appends tool results as new messages
    |
Runtime sends updated conversation back to model
    |
Model continues generating (may call more tools or produce final text)
```

---

## 6. Model Selection & Routing

### Selection Criteria

```typescript
function selectModel(
    task: TaskType,
    userPreference?: string
): ModelConfig {
    switch (task) {
        case "chat":
            return fastCheapModel;     // e.g. gpt-4o-mini
        case "code":
            return bestCodeModel;      // e.g. claude-3.5-sonnet
        case "analysis":
            return strongestModel;      // e.g. gpt-4o or claude-3-opus
        case "stream":
            return lowLatencyModel;     // e.g. local ollama
    }
}
```

### Fallback Chain

```typescript
async function completeWithFallback(
    request: CompletionRequest
): Promise<CompletionResult> {
    const models = [
        request.model,
        ...fallbackModels[request.model.provider],
        ...anyFallbackModels,
    ];

    for (const model of models) {
        try {
            return await attemptCompletion({ ...request, model });
        } catch (err) {
            if (isRetryable(err)) continue;
            throw err; // non-retryable error
        }
    }
    throw new Error("All models failed");
}
```

---

## 7. Token Management

### Context Window Budgeting

```typescript
function buildContext(
    messages: Message[],
    model: ModelConfig,
    systemPrompt: string
): Message[] {
    const maxTokens = model.contextWindow - model.maxTokens - 1000; // 1k safety margin

    // Tokenize messages to count (using tiktoken or similar)
    let totalTokens = countTokens(systemPrompt) + countTokens(messages);

    // Trim oldest messages if over budget
    while (totalTokens > maxTokens && messages.length > 1) {
        const removed = messages.shift()!;
        totalTokens -= countTokens(removed);
    }

    return [{ role: "system", content: systemPrompt }, ...messages];
}
```

### Usage Tracking

```typescript
class UsageTracker {
    private totalInput: number = 0;
    private totalOutput: number = 0;
    private totalCost: number = 0;

    track(result: CompletionResult, model: ModelConfig): void {
        this.totalInput += result.usage.inputTokens;
        this.totalOutput += result.usage.outputTokens;
        this.totalCost +=
            (result.usage.inputTokens / 1000) * model.costPer1kInput +
            (result.usage.outputTokens / 1000) * model.costPer1kOutput;
    }

    getStats(): UsageStats {
        return {
            totalInputTokens: this.totalInput,
            totalOutputTokens: this.totalOutput,
            estimatedCostUSD: this.totalCost,
        };
    }
}
```

---

## 8. Configuration File

```json
{
    "models": {
        "primary": {
            "id": "gpt-4o",
            "provider": "openai",
            "baseUrl": "https://api.openai.com/v1",
            "apiKeyEnvVar": "OPENAI_API_KEY",
            "maxTokens": 4096,
            "contextWindow": 128000,
            "supportsTools": true
        },
        "fallback": {
            "id": "claude-3-haiku",
            "provider": "anthropic",
            "baseUrl": "https://api.anthropic.com/v1",
            "apiKeyEnvVar": "ANTHROPIC_API_KEY",
            "maxTokens": 4096,
            "contextWindow": 200000,
            "supportsTools": true
        },
        "local": {
            "id": "codellama",
            "provider": "ollama",
            "baseUrl": "http://localhost:11434/v1",
            "apiKeyEnvVar": "",
            "maxTokens": 2048,
            "contextWindow": 8192,
            "supportsTools": false
        }
    },
    "routing": {
        "chat": "primary",
        "code": "primary",
        "quick": "local"
    }
}
```

---

## 9. Key Decisions

| Decision | Rationale |
|----------|-----------|
| Provider abstraction via adapters | Avoids locking into one provider; new models appear constantly |
| SSE streaming for all providers | Users see tokens immediately; feels responsive |
| Tool calls intercepted mid-stream | Tool JSON is not shown to the user; execution is transparent |
| Token counting done locally | Avoids sending extra API calls just to count tokens |
| Fallback chain with retry | Providers fail; your tool should degrade gracefully, not crash |
| AbortSignal for cancellation | Users must be able to stop generation (Ctrl+C) |

---

## 10. Files

```
src/
  llm/
    router.ts          -- model selection + fallback
    adapter.ts         -- abstract base class for providers
    adapters/
      openai.ts
      anthropic.ts
      ollama.ts
      google.ts
    stream.ts          -- SSE parsing + token iteration
    tokenizer.ts       -- local token counting
    usage.ts           -- cost tracking
    config.ts          -- model configuration schema
    types.ts           -- all shared types
```
