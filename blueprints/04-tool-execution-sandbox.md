# Blueprint: Tool Execution Sandbox

> How tools are defined, registered, sandboxed, and executed -- the safety boundary between the model and the operating system.

---

## 1. Responsibility

The Tool Execution Sandbox is the runtime's mechanism for allowing the model to interact with the file system, shell, network, and user. Every tool call from the model passes through this layer, which:

- Defines the schema for each tool (name, description, parameters)
- Registers tools from both the core runtime and plugins
- Executes tool calls in a restricted environment with timeouts and path guards
- Formats tool results back into the conversation
- Prevents the model from executing arbitrary or dangerous operations

---

## 2. Core Types

```typescript
// --- Tool Definition ---
interface ToolDefinition {
    name: string;                          // unique identifier, snake_case
    description: string;                   // shown to the model to guide selection
    parameters: JSONSchema;                // JSON Schema for argument validation
    handler: ToolHandler;                  // the actual implementation
    visibility?: "public" | "internal";    // internal tools hidden from model
    timeout?: number;                      // ms, default 30000
    sandbox?: SandboxConfig;               // execution restrictions
}

type ToolHandler = (
    args: Record<string, unknown>,
    context: ToolContext
) => Promise<ToolResult>;

// --- Execution Context ---
interface ToolContext {
    sessionId: string;
    workingDirectory: string;
    env: Record<string, string | undefined>;
    allowedPaths: string[];                // read/write path whitelist
    signal: AbortSignal;                   // for cancellation
    log: (message: string) => void;        // audit trail
    askUser?: QuestionFunction;            // for interactive tools
}

// --- Results ---
interface ToolResult {
    content: string;                       // markdown-formatted result text
    metadata?: {
        truncated?: boolean;
        durationMs?: number;
        exitCode?: number;
        filesRead?: string[];
        filesWritten?: string[];
    };
    isError?: boolean;                     // tool failed vs succeeded
}

// --- JSON Schema subset ---
interface JSONSchema {
    type: "object" | "string" | "number" | "boolean" | "array";
    properties?: Record<string, JSONSchema>;
    required?: string[];
    description?: string;
    items?: JSONSchema;
    enum?: string[];
    default?: unknown;
}
```

---

## 3. Architecture

```
Model generates tool call JSON
    |
    v
+----------------------------+
| Tool Call Parser            |
| - extracts name + args      |
| - validates against schema  |
+----------------------------+
    |
    v
+----------------------------+
| Tool Registry               |
| - looks up handler by name  |
| - resolves plugin-provided  |
|   vs core tools             |
+----------------------------+
    |
    v
+----------------------------+
| Sandbox Enforcer            |
| - applies timeouts          |
| - checks path restrictions  |
| - validates arguments       |
| - enforces read-only flags  |
+----------------------------+
    |
    v
+----------------------------+
| Handler Executor            |
| - runs the handler function |
| - captures stdout/stderr    |
| - measures duration         |
+----------------------------+
    |
    v
+----------------------------+
| Result Formatter            |
| - truncates if too long     |
| - wraps in markdown         |
| - attaches metadata         |
+----------------------------+
    |
    v
Tool result appended to conversation messages
```

---

## 4. Tool Registration & Discovery

### 4.1 Core Tools (built into the runtime)

Registered at startup from a static manifest:

```typescript
const coreTools: ToolDefinition[] = [
    {
        name: "read",
        description: "Read the contents of a file or directory from the local filesystem.",
        parameters: {
            type: "object",
            properties: {
                filePath: { type: "string", description: "Absolute path to the file" },
                offset: { type: "number", description: "Line number to start from" },
                limit: { type: "number", description: "Max lines to read" },
            },
            required: ["filePath"],
        },
        handler: readHandler,
        timeout: 10000,
        sandbox: { allowedOperations: ["read"] },
    },
    {
        name: "bash",
        description: "Execute a shell command with optional timeout.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The command to execute" },
                description: { type: "string", description: "5-10 word description" },
                timeout: { type: "number", description: "Timeout in milliseconds" },
            },
            required: ["command", "description"],
        },
        handler: bashHandler,
        timeout: 120000,
        sandbox: { allowedOperations: ["shell"] },
    },
    // ... write, edit, grep, glob, webfetch, websearch, task, question, todowrite, skill
];
```

### 4.2 Plugin Tools

Plugins register tools through the plugin slot system:

```typescript
// Inside a plugin's register call
plugin.registerTool({
    name: "search_docs",
    description: "Search internal documentation",
    parameters: { /* ... */ },
    handler: async (args, ctx) => {
        const results = await searchInternalDocs(args.query);
        return { content: formatResults(results) };
    },
});
```

### 4.3 Registry Resolution

```typescript
class ToolRegistry {
    private tools: Map<string, ToolDefinition> = new Map();

    register(tool: ToolDefinition): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Duplicate tool registration: ${tool.name}`);
        }
        this.tools.set(tool.name, tool);
    }

    getToolDefinitions(forModel: boolean = true): ToolDefinition[] {
        const result: ToolDefinition[] = [];
        for (const tool of this.tools.values()) {
            if (forModel && tool.visibility === "internal") continue;
            result.push(tool);
        }
        return result;
    }

    async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
        const tool = this.tools.get(name);
        if (!tool) {
            return {
                content: `Error: Unknown tool "${name}". Available: ${[...this.tools.keys()].join(", ")}`,
                isError: true,
            };
        }
        return await this.runWithSandbox(tool, args as Record<string, unknown>, ctx);
    }
}
```

---

## 5. Sandbox Enforcement

### 5.1 Timeout

Every tool execution gets a timeout. If the handler does not complete within the limit, it is aborted.

```typescript
async function runWithTimeout<T>(
    handler: () => Promise<T>,
    timeoutMs: number,
    signal: AbortSignal
): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new CancelledError());
        });
    });

    return await Promise.race([handler(), timeout]);
}
```

### 5.2 Path Restrictions

Tools that read or write files are restricted to a whitelist of allowed directories:

```typescript
function resolvePath(requestedPath: string, allowedPaths: string[]): string {
    const resolved = path.resolve(requestedPath);

    // Deny traversal outside allowed roots
    const isAllowed = allowedPaths.some((allowed) =>
        resolved.startsWith(path.resolve(allowed))
    );

    if (!isAllowed) {
        throw new SandboxError(
            `Access denied: "${resolved}" is outside allowed paths`
        );
    }

    return resolved;
}
```

### 5.3 Argument Validation

Every tool's arguments are validated against its JSON Schema before execution:

```typescript
function validateArgs(args: unknown, schema: JSONSchema): Record<string, unknown> {
    if (typeof args !== "object" || args === null) {
        throw new ValidationError("Arguments must be an object");
    }

    const typed = args as Record<string, unknown>;

    // Check required fields
    for (const key of schema.required ?? []) {
        if (!(key in typed)) {
            throw new ValidationError(`Missing required argument: "${key}"`);
        }
    }

    // Type-check each property
    for (const [key, value] of Object.entries(typed)) {
        const propSchema = schema.properties?.[key];
        if (propSchema && value !== undefined) {
            validateType(value, propSchema);
        }
    }

    return typed;
}
```

### 5.4 Shell Command Safety

The `bash` tool has extra guards:

```typescript
function validateShellCommand(command: string): void {
    // Block interactive commands that would hang
    const blocked = ["vim", "nano", "less", "more", "top", "htop"];
    const firstWord = command.trim().split(/\s+/)[0];
    if (blocked.includes(firstWord)) {
        throw new SandboxError(`Interactive command not allowed: ${firstWord}`);
    }

    // Limit command length
    if (command.length > 8000) {
        throw new SandboxError("Command exceeds 8000 character limit");
    }

    // Warn about dangerous operations (log, but don't block)
    const dangerous = ["rm -rf /", "format", "del /f /s"];
    for (const pattern of dangerous) {
        if (command.toLowerCase().includes(pattern.toLowerCase())) {
            console.warn(`Potentially dangerous command: ${command}`);
        }
    }
}
```

---

## 6. Execution Pipeline (Full Flow)

```
1. Model outputs: {"name": "read", "args": {"filePath": "/etc/hosts"}}
    |
2. Parser extracts name + args from tool call delta/block
    |
3. Registry looks up "read" -> finds ToolDefinition
    |
4. Validator checks args against schema:
   - "filePath" is present (required)
   - "filePath" is a string (type check)
   - No unknown properties
    |
5. Sandbox enforcer:
   - Resolves "filePath" against allowedPaths
   - Checks read operation is allowed
   - Sets up timeout (10s for read)
    |
6. Handler executes:
   - fs.readFile() with resolved path
   - Reads up to limit lines
   - Catches ENOENT, EACCES, etc.
    |
7. Result formatter:
   - Wraps in markdown code block
   - Adds metadata (truncated, durationMs)
   - Truncates at 50KB max
    |
8. Result appended to messages array as tool role
    |
9. Loop: runtime sends updated messages back to model
```

---

## 7. Tool Result Formatting

### 7.1 Success Result

```typescript
function formatSuccess(content: string, meta: Partial<ToolResult["metadata"]>): ToolResult {
    // Truncate if content exceeds maximum
    const MAX_RESULT_SIZE = 50_000; // characters
    const truncated = content.length > MAX_RESULT_SIZE;

    return {
        content: truncated
            ? content.slice(0, MAX_RESULT_SIZE) +
              `\n\n... [truncated at ${MAX_RESULT_SIZE} chars]`
            : content,
        metadata: {
            truncated,
            durationMs: meta.durationMs,
            ...meta,
        },
    };
}
```

### 7.2 Error Result

```typescript
function formatError(error: unknown): ToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: `Error: ${message}`,
        isError: true,
        metadata: {
            durationMs: 0,
        },
    };
}
```

### 7.3 Special: Question Tool

The `question` tool is interactive -- it suspends the model loop and waits for user input:

```typescript
const questionTool: ToolDefinition = {
    name: "question",
    description: "Ask the user a question when you need clarification or a decision.",
    parameters: {
        type: "object",
        properties: {
            questions: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        question: { type: "string" },
                        header: { type: "string" },
                        options: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    label: { type: "string" },
                                    description: { type: "string" },
                                },
                            },
                        },
                    },
                },
            },
        },
        required: ["questions"],
    },
    handler: async (args, ctx) => {
        const answers = await ctx.askUser!(args.questions);
        return { content: JSON.stringify(answers, null, 2) };
    },
    timeout: 300_000, // 5 minutes -- user might take a while
};
```

---

## 8. Tool Execution Statistics

Each tool execution is recorded for diagnostics and user feedback:

```typescript
interface ToolExecutionRecord {
    name: string;
    timestamp: number;
    args: Record<string, unknown>;
    durationMs: number;
    success: boolean;
    resultSize: number;
    truncated: boolean;
}

class ToolAuditor {
    private history: ToolExecutionRecord[] = [];
    private maxHistory = 100;

    record(execution: ToolExecutionRecord): void {
        this.history.push(execution);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
    }

    getStats(): ToolStats {
        const total = this.history.length;
        const failed = this.history.filter((r) => !r.success).length;
        const avgDuration =
            total > 0
                ? this.history.reduce((s, r) => s + r.durationMs, 0) / total
                : 0;

        return { totalExecutions: total, failed, avgDurationMs: Math.round(avgDuration) };
    }

    getLastFew(n: number = 5): ToolExecutionRecord[] {
        return this.history.slice(-n);
    }
}
```

---

## 9. Key Decisions

| Decision | Rationale |
|----------|-----------|
| JSON Schema for parameter validation | Industry standard; model providers natively understand it |
| AbortSignal for cancellation | Native JS API; integrates with fetch, file streams |
| Path whitelist, not blacklist | Whitelist is safer by default; blacklists are never complete |
| Tool results as conversation messages | Model sees the full context including what tools returned |
| 50KB result truncation | Prevents token overflow; model rarely needs every byte |
| Interactive tools handled as tool calls | Consistent with the tool abstraction; user input is just another result |
| Audit trail of last 100 calls | Debugging without unbounded memory growth |

---

## 10. Files

```
src/
  tools/
    registry.ts          -- ToolRegistry class, registration, lookup
    sandbox.ts           -- timeout, path resolution, shell validation
    validator.ts         -- JSON Schema argument validation
    auditor.ts           -- execution recording and stats
    formatter.ts         -- result formatting, truncation
    core/
      read.ts
      write.ts
      edit.ts
      bash.ts
      grep.ts
      glob.ts
      webfetch.ts
      websearch.ts
      task.ts
      question.ts
      todowrite.ts
      skill.ts
    types.ts             -- all shared types
```
