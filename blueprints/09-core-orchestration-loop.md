# Blueprint: Core Orchestration Loop

> The main event loop -- startup sequence, message pipeline, error recovery, and the central nervous system that connects every other component.

---

## 1. Responsibility

The Orchestration Loop is the runtime itself. It is the code that actually *runs* -- the sequence of operations that turns user input into model responses, tool executions, and screen updates. It is not a library or a subsystem; it is the application.

It handles:

- Booting the runtime in the correct order
- Running the main session loop (user input -> LLM -> tools -> LLM -> render)
- Deciding when to pause, resume, or terminate the loop
- Recovering from errors at every stage
- Coordinating between the LLM, tool sandbox, session manager, and TUI

---

## 2. Architecture: The Main Loop

```
+==================================================================+
|                      STARTUP SEQUENCE                            |
|  CLI args -> Config resolve -> Rust binary -> Plugin load        |
|  -> Session create/load -> TUI init -> Terminal raw mode         |
+==================================================================+
    |
    v
+==================================================================+
|                      MAIN SESSION LOOP                           |
|  +----------------------------------------------------------+   |
|  |  1. Render current conversation to TUI                   |   |
|  |  2. Wait for user input (keyboard)                      |   |
|  |  3. Dispatch input:                                     |   |
|  |     - '/' command? -> handleCommand()                   |   |
|  |     - regular text? -> append user message              |   |
|  |  4. Build context (system prompt + conversation)        |   |
|  |  5. Stream LLM response:                                |   |
|  |     a. Render tokens as they arrive                     |   |
|  |     b. Intercept tool call deltas                       |   |
|  |     c. On tool call: pause streaming                   |   |
|  |  6. Execute tool(s) via sandbox                         |   |
|  |  7. Append tool results as messages                     |   |
|  |  8. Go to step 4 (continue LLM with tool results)       |   |
|  |  9. When LLM finishes: go to step 1                    |   |
|  +----------------------------------------------------------+   |
+==================================================================+
    |
    v
+==================================================================+
|                      SHUTDOWN SEQUENCE                          |
|  Save session -> Plugin cleanup -> TUI teardown ->              |
|  Terminal restore -> Exit                                       |
+==================================================================+
```

---

## 3. Startup Sequence (in dependency order)

```typescript
async function main() {
    let exitCode = 0;

    try {
        // Phase 1: Parse CLI arguments
        const cliArgs = parseCliArgs(process.argv.slice(2));

        if (cliArgs.version) {
            console.log(getVersion());
            return;
        }

        // Phase 2: Resolve configuration
        const config = await new ConfigResolver().resolve(cliArgs.config);

        // Phase 3: Initialize logging
        initLogger(config.logLevel, config.verbose);

        // Phase 4: Plugin loader -- discover and register plugins
        const pluginLoader = new PluginLoader({
            pluginsDir: config.paths.pluginsDir,
            cacheDir: config.paths.cacheDir,
        });
        const plugins = await pluginLoader.loadAll();

        // Phase 5: Tool registry -- core tools + plugin tools
        const toolRegistry = new ToolRegistry();
        registerCoreTools(toolRegistry, config);
        for (const plugin of plugins) {
            plugin.registerTools(toolRegistry);
        }

        // Phase 6: Session management
        const sessionManager = new SessionManager({
            sessionsDir: config.paths.sessionsDir,
        });
        let session = cliArgs.session
            ? await sessionManager.load(cliArgs.session)
            : null;
        if (!session) {
            session = await sessionManager.create(
                process.cwd(),
                config.defaultModel
            );
        }

        // Phase 7: LLM router
        const llmRouter = new LlmRouter(config.models);
        const usageTracker = new UsageTracker();

        // Phase 8: TUI initialization
        // (This is where terminal raw mode is enabled,
        //  the alt screen is entered, and the UI renders)
        const tui = await Tui.init({
            theme: config.theme,
            colors: config.colors,
        });

        // Phase 9: Signal handlers for graceful shutdown
        setupSignalHandlers(() => shutdown(sessionManager, tui, pluginLoader));

        // Phase 10: Enter the main loop
        await runSessionLoop({
            tui,
            session,
            sessionManager,
            llmRouter,
            toolRegistry,
            usageTracker,
            config,
            plugins,
        });
    } catch (err) {
        console.error("Fatal startup error:", err);
        exitCode = 1;
    } finally {
        await shutdownResources();
        process.exit(exitCode);
    }
}
```

---

## 4. The Session Loop (Detailed)

```typescript
async function runSessionLoop(context: SessionContext): Promise<void> {
    const { tui, session, llmRouter, toolRegistry, config } = context;

    // Render initial state
    tui.render(session.messages);

    while (true) {
        // ---- Phase 1: Wait for user input ----
        const input = await tui.waitForInput();

        // ---- Phase 2: Handle input ----
        if (input.startsWith("/")) {
            const handled = await handleCommand(input, context);
            if (handled === "exit") break;
            if (handled === "reset") {
                session = await context.sessionManager.create();
                tui.render(session.messages);
                continue;
            }
            tui.render(session.messages);
            continue;
        }

        // ---- Phase 3: Append user message ----
        const userMessage: Message = {
            role: "user",
            content: input,
            timestamp: new Date().toISOString(),
        };
        session = await context.sessionManager.append(userMessage);
        tui.render(session.messages);

        // ---- Phase 4: Main LLM + Tool Loop ----
        await runAssistantLoop(context, session);

        // ---- Phase 5: Done -- render final state ----
        tui.render(session.messages);
    }
}
```

### 4.1 The Assistant Loop (LLM + Tool Calls)

```typescript
async function runAssistantLoop(
    context: SessionContext,
    session: SessionFile
): Promise<void> {
    const { tui, llmRouter, toolRegistry, usageTracker, config } = context;

    let turnCount = 0;
    const MAX_TOOL_TURNS = 25; // safety limit

    while (turnCount < MAX_TOOL_TURNS) {
        turnCount++;

        // ---- Step A: Build context from session messages ----
        const modelConfig = llmRouter.selectModel("chat", config.defaultModel);
        const messages = buildContext(session.messages, modelConfig);

        // ---- Step B: Prepare assistant message placeholder ----
        const assistantMsg: AssistantMessage = {
            role: "assistant",
            content: "",
            tool_calls: [],
            timestamp: new Date().toISOString(),
            streaming: true,
        };
        session.messages.push(assistantMsg);
        tui.render(session.messages);

        // ---- Step C: Stream LLM response ----
        const abortController = new AbortController();

        // Allow Ctrl+C to cancel generation
        const cancelHandler = () => abortController.abort();
        process.on("SIGINT", cancelHandler);

        try {
            let toolCallsAccumulator: ToolCall[] = [];

            for await (const event of llmRouter.streamCompletion({
                messages,
                model: modelConfig,
                tools: toolRegistry.getToolDefinitions(true),
                signal: abortController.signal,
            })) {
                switch (event.type) {
                    case "token":
                        // Append token to assistant message content
                        assistantMsg.content += event.token;
                        tui.renderIncremental(session.messages);
                        break;

                    case "tool_call_delta":
                        // Accumulate partial tool call data
                        this.accumulateToolCall(toolCallsAccumulator, event.delta);
                        break;

                    case "tool_call_complete":
                        // A full tool call is ready
                        toolCallsAccumulator.push(event.call);
                        break;
                }
            }

            // Finalize the assistant message
            assistantMsg.streaming = false;
            assistantMsg.tool_calls = toolCallsAccumulator;

            // Track usage
            usageTracker.track({
                inputTokens: estimateTokens(messages),
                outputTokens: estimateTokens(assistantMsg.content),
            }, modelConfig);

        } catch (err) {
            assistantMsg.streaming = false;
            if (abortController.signal.aborted) {
                // User cancelled -- that's fine
                assistantMsg.content += "\n\n[Cancelled]";
            } else {
                // Real error -- note it and continue
                assistantMsg.content += `\n\n[Error: ${err.message}]`;
                logError("LLM streaming failed", err);
            }
        } finally {
            process.removeListener("SIGINT", cancelHandler);
        }

        // ---- Step D: Execute tool calls if any ----
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
            tui.showToolStatus(`Executing ${assistantMsg.tool_calls.length} tool(s)...`);

            for (const toolCall of assistantMsg.tool_calls) {
                const result = await toolRegistry.execute(
                    toolCall.function.name,
                    JSON.parse(toolCall.function.arguments),
                    {
                        sessionId: session.meta.id,
                        workingDirectory: session.meta.projectRoot ?? process.cwd(),
                        allowedPaths: config.tools.allowedPaths,
                        signal: abortController.signal,
                        log: (msg) => logTool(toolCall.function.name, msg),
                    }
                );

                // Append tool result as a message
                session.messages.push({
                    role: "tool",
                    content: result.content,
                    tool_call_id: toolCall.id,
                    name: toolCall.function.name,
                    timestamp: new Date().toISOString(),
                });

                // Record in auditor
                session.toolHistory.push({
                    name: toolCall.function.name,
                    timestamp: Date.now(),
                    durationMs: result.metadata?.durationMs ?? 0,
                    success: !result.isError,
                    resultSize: result.content.length,
                });
            }

            tui.clearToolStatus();

            // ---- Step E: Loop back -- send tool results to LLM ----
            // (The tool results are already appended to session.messages,
            //  so the next iteration of the while loop will include them)
            continue;
        }

        // ---- No tool calls -- assistant is done ----
        break;
    }

    // Save session after assistant turn
    await context.sessionManager.save(session);

    if (turnCount >= MAX_TOOL_TURNS) {
        logWarn(`Hit MAX_TOOL_TURNS (${MAX_TOOL_TURNS}) -- breaking loop`);
        session.messages.push({
            role: "system",
            content: `[Reached maximum tool call limit (${MAX_TOOL_TURNS}). Ending turn.]`,
            timestamp: new Date().toISOString(),
            hidden: true,
        });
    }
}
```

---

## 5. Command Handling (`/` commands)

```typescript
type CommandResult = "continue" | "exit" | "reset";

async function handleCommand(
    input: string,
    context: SessionContext
): Promise<CommandResult> {
    const parts = input.slice(1).trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
        case "exit":
        case "quit":
            return "exit";

        case "clear":
            context.session.clearVisible();
            return "continue";

        case "reset":
            return "reset";

        case "session":
            return handleSessionCommand(args, context);

        case "set":
            return handleSetCommand(args, context);

        case "help":
            context.tui.showHelp();
            return "continue";

        case "model":
            return handleModelCommand(args, context);

        case "export":
            return handleExportCommand(args, context);

        default:
            context.tui.showError(`Unknown command: /${cmd}. Try /help.`);
            return "continue";
    }
}

// Subcommand handlers
async function handleSessionCommand(
    args: string[],
    context: SessionContext
): Promise<CommandResult> {
    const sub = args[0];

    if (sub === "list") {
        const sessions = await context.sessionManager.list();
        context.tui.showSessionList(sessions);
        return "continue";
    }

    if (sub === "load" && args[1]) {
        const loaded = await context.sessionManager.load(args[1]);
        if (loaded) {
            context.session = loaded;
            context.tui.render(loaded.messages);
            context.tui.showInfo(`Loaded session ${args[1]}`);
        } else {
            context.tui.showError(`Session not found: ${args[1]}`);
        }
        return "continue";
    }

    if (sub === "save") {
        await context.sessionManager.save(context.session);
        context.tui.showInfo("Session saved.");
        return "continue";
    }

    if (sub === "rename" && args[1]) {
        context.session.meta.title = args.slice(1).join(" ");
        await context.sessionManager.save(context.session);
        context.tui.showInfo(`Session renamed to "${context.session.meta.title}".`);
        return "continue";
    }

    if (sub === "delete" && args[1]) {
        await context.sessionManager.delete(args[1]);
        context.tui.showInfo(`Deleted session ${args[1]}.`);
        return "continue";
    }

    context.tui.showError("Usage: /session [list|load|save|rename|delete]");
    return "continue";
}
```

---

## 6. Error Handling & Recovery Taxonomy

Every error in the system falls into one of these categories, with a defined response:

### 6.1 Error Categories

| Category | Examples | Recovery |
|----------|----------|----------|
| **Fatal** | Config parse failure, port conflict, Rust binary crash | Shutdown immediately, show error, restore terminal |
| **Retryable** | LLM API timeout, network failure, rate limit | Retry 3x with exponential backoff, then downgrade to fallback model |
| **Degraded** | Plugin load failure, tool timeout, token limit hit | Continue without the failed component, warn the user |
| **User-cancelled** | Ctrl+C during generation | Stop streaming, keep partial response, return to input |
| **Recoverable tool** | File not found, permission denied, command failed | Return error as tool result, let the model decide what to do |
| **Corruption** | Session file parse error, config schema violation | Fall back to defaults, offer to repair or reset |

### 6.2 Retry Logic

```typescript
async function withRetry<T>(
    fn: () => Promise<T>,
    options: {
        maxRetries?: number;
        baseDelayMs?: number;
        onRetry?: (attempt: number, error: Error) => void;
    } = {}
): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    const baseDelay = options.baseDelayMs ?? 1000;

    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;

            if (attempt < maxRetries && isRetryable(err)) {
                const delay = baseDelay * Math.pow(2, attempt); // exponential backoff
                options.onRetry?.(attempt + 1, err);
                await sleep(delay);
            } else {
                throw err;
            }
        }
    }

    throw lastError!;
}

function isRetryable(err: Error): boolean {
    const retryableMessages = [
        "timeout",
        "rate limit",
        "too many requests",
        "429",
        "503",
        "network",
        "econnreset",
        "econnrefused",
        "socket hang up",
    ];
    const msg = err.message.toLowerCase();
    return retryableMessages.some((pattern) => msg.includes(pattern));
}
```

### 6.3 Graceful Degradation

```typescript
async function tryLoadPlugin(path: string): Promise<Plugin | null> {
    try {
        return await PluginLoader.load(path);
    } catch (err) {
        logWarn(`Failed to load plugin "${path}": ${err.message}`);
        logWarn("Continuing without this plugin.");
        return null;
    }
}

async function tryTool(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    try {
        return await executeTool(toolCall, context);
    } catch (err) {
        return {
            content: `Error executing ${toolCall.function.name}: ${err.message}`,
            isError: true,
            metadata: { durationMs: 0 },
        };
    }
}
```

### 6.4 Shutdown Sequence

```typescript
async function shutdown(
    sessionManager: SessionManager,
    tui: Tui,
    pluginLoader: PluginLoader
): Promise<void> {
    logInfo("Shutting down...");

    // Phase 1: Save session state
    try {
        await sessionManager.save();
    } catch (err) {
        logError("Failed to save session", err);
    }

    // Phase 2: Notify plugins
    try {
        await pluginLoader.shutdownAll();
    } catch (err) {
        logError("Plugin shutdown error", err);
    }

    // Phase 3: Restore terminal (TUI destructor handles this)
    try {
        tui.shutdown();
    } catch (err) {
        logError("TUI shutdown error", err);
    }

    // Phase 4: Terminal is restored by TerminalGuard's Drop (Rust layer)
    // Phase 5: Process exit
    logInfo("Goodbye.");
}
```

---

## 7. Threading & Concurrency Model

```
Main thread (JS):          Event loop, rendering, input dispatch
                           |
LLM streaming (async):     Async generator, yields tokens to main loop
                           |
Tool execution:            Can be async (read/write) or subprocess (bash)
                           |
Rust layer (separate proc): Raw input polling, raw mode, subprocess spawn
                           |
Plugin loading:            Sequential at startup, async during runtime
```

**Key rules:**
- The main loop is single-threaded (JavaScript event loop)
- LLM streaming uses async iteration (not worker threads)
- Tool execution is async but can delegate to Rust subprocess for blocking work
- Rendering is synchronous and happens after each state change
- Input is polled by the Rust layer and forwarded as JSON messages

---

## 8. Key Decisions

| Decision | Rationale |
|----------|-----------|
| Single-threaded main loop | Simplicity; async handles concurrent I/O without thread complexity |
| Tool calls break streaming | The model expects tool results before continuing; cannot stream while executing |
| MAX_TOOL_TURNS = 25 | Prevents infinite loops; lets the model run deep but not forever |
| Ctrl+C cancels generation, not the app | User experience: casual cancellation should not exit |
| Retry with exponential backoff | Prevents hammering flaky APIs; gives them time to recover |
| Degraded mode instead of crash | A partially working tool is better than no tool at all |
| Shutdown is phased and fallible | Each phase attempts cleanup even if prior phases fail |

---

## 9. Files

```
src/
  main.ts                  -- entry point, startup sequence
  loop/
    session-loop.ts        -- main user -> assistant loop
    assistant-loop.ts      -- LLM + tool call loop
    commands.ts            -- /command handlers
    shutdown.ts            -- graceful shutdown
    context.ts             -- SessionContext type and builder
  errors/
    categories.ts          -- error taxonomy
    retry.ts               -- exponential backoff retry
    recovery.ts            -- degraded mode helpers
    fatal.ts               -- fatal error display and exit
  signals.ts               -- SIGINT, SIGTERM, SIGHUP handlers
```
