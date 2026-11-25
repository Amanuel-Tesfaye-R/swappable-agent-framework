# Blueprint: CLI Surface, Testing & Build Order

> The user-facing command structure, the development lifecycle, how to test the terminal UI, and the dependency graph that tells you what to build first.

---

## 1. Responsibility

This blueprint covers everything that wraps around the components -- the shape of the binary users interact with, how the project is organized for development, how to verify it works, and the order in which components must be built.

It answers three questions:
1. What does the user type, and what happens?
2. How do I build and test this thing?
3. What do I build first?

---

## 2. CLI Surface

### 2.1 Binary Entry Points

```
opencode          -> Interactive session (default)
opencode chat     -> Interactive session (explicit)
opencode "prompt" -> One-shot: run prompt, print response, exit
opencode < file   -> Pipe mode: read from stdin
mesob            -> Alias for opencode (symbolic link or wrapper script)

Subcommands:
  opencode session list        -> List saved sessions
  opencode session load <id>   -> Resume a session
  opencode session delete <id> -> Remove a session file
  opencode config show         -> Print resolved configuration
  opencode config set <key> <value> -> Update config
  opencode plugin list         -> List installed plugins
  opencode plugin install <pkg> -> Install a plugin
  opencode version             -> Print version and exit
  opencode help                -> Print help and exit
```

### 2.2 Argument Parsing

```typescript
interface ParsedCli {
    // Mode
    mode: "interactive" | "oneshot" | "pipe" | "subcommand";

    // Subcommand (for "subcommand" mode)
    subcommand?: string[];
    subcommandName?: string;

    // One-shot prompt
    prompt?: string;

    // General flags
    config?: string;              // --config / -c <path>
    model?: string;               // --model <name>
    session?: string;             // --session / -s <id>
    verbose?: boolean;            // --verbose / -v
    version?: boolean;            // --version
    help?: boolean;               // --help

    // Non-interactive
    noTui?: boolean;              // --no-tui (for scripting)
    outputFormat?: "text" | "json"; // --json

    // Session file
    projectDir?: string;
}

function parseCliArgs(argv: string[]): ParsedCli {
    const result: ParsedCli = {
        mode: "interactive",
    };

    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];

        // --flags
        if (arg.startsWith("--")) {
            const flag = arg.slice(2);
            const value = getValue(argv, i);
            switch (flag) {
                case "config":      result.config = value; i += 2; break;
                case "model":       result.model = value; i += 2; break;
                case "session":     result.session = value; i += 2; break;
                case "verbose":     result.verbose = true; i++; break;
                case "version":     result.version = true; i++; break;
                case "help":        result.help = true; i++; break;
                case "no-tui":      result.noTui = true; i++; break;
                case "json":        result.outputFormat = "json"; i++; break;
                default:            throw new Error(`Unknown flag: --${flag}`);
            }
            continue;
        }

        // -short flags
        if (arg.startsWith("-") && arg.length === 2) {
            const flag = arg[1];
            const value = getValue(argv, i);
            switch (flag) {
                case "c": result.config = value; i += 2; break;
                case "m": result.model = value; i += 2; break;
                case "s": result.session = value; i += 2; break;
                case "v": result.verbose = true; i++; break;
                default:  throw new Error(`Unknown flag: -${flag}`);
            }
            continue;
        }

        // Positional arguments determine mode
        if (i === 0) {
            if (arg === "chat") {
                result.mode = "interactive";
                i++;
                continue;
            }
            if (arg === "session" || arg === "config" || arg === "plugin") {
                result.mode = "subcommand";
                result.subcommandName = arg;
                result.subcommand = argv.slice(i + 1);
                break;
            }
            if (arg === "help") {
                result.help = true;
                i++;
                continue;
            }
            if (arg === "version") {
                result.version = true;
                i++;
                continue;
            }

            // If it doesn't match a subcommand, treat as one-shot prompt
            result.mode = "oneshot";
            result.prompt = argv.slice(i).join(" ");
            break;
        }

        i++;
    }

    // Check for pipe mode (stdin not a TTY)
    if (!process.stdin.isTTY && result.mode === "interactive") {
        result.mode = "pipe";
    }

    return result;
}

function getValue(argv: string[], index: number): string {
    if (index + 1 >= argv.length || argv[index + 1].startsWith("-")) {
        throw new Error(`Flag ${argv[index]} requires a value`);
    }
    return argv[index + 1];
}
```

### 2.3 Mode Dispatch

```typescript
async function main() {
    const cli = parseCliArgs(process.argv.slice(2));

    if (cli.version)   { printVersion(); return; }
    if (cli.help)      { printHelp(); return; }

    switch (cli.mode) {
        case "subcommand":
            await handleSubcommand(cli);
            break;

        case "oneshot":
            await runOneshot(cli.prompt!, cli);
            break;

        case "pipe":
            const stdin = await readStdin();
            await runOneshot(stdin, cli);
            break;

        case "interactive":
        default:
            await runInteractive(cli);
            break;
    }
}
```

### 2.4 One-Shot Mode (Non-Interactive)

```typescript
async function runOneshot(prompt: string, cli: ParsedCli): Promise<void> {
    // Minimal startup -- no TUI, no plugin system
    const config = await new ConfigResolver().resolve(cli.config);
    const llmRouter = new LlmRouter(config.models);

    // Single LLM call, print response, exit
    const model = llmRouter.selectModel("chat", cli.model ?? config.defaultModel);

    try {
        const stream = llmRouter.streamCompletion({
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt },
            ],
            model,
            stream: true,
            tools: getCoreToolDefinitions(),
        });

        let fullResponse = "";
        for await (const event of stream) {
            if (event.type === "token") {
                process.stdout.write(event.token);
                fullResponse += event.token;
            }
            // Tool calls in one-shot mode? Either execute or warn.
            if (event.type === "tool_call_complete") {
                logWarn("One-shot mode does not execute tool calls.");
            }
        }

        if (cli.outputFormat === "json") {
            console.log(JSON.stringify({ response: fullResponse }));
        }
    } catch (err) {
        console.error("\nError:", err.message);
        process.exit(1);
    }
}
```

### 2.5 Help Output

```
Usage: opencode [options] [command] [prompt...]

An AI-powered coding assistant for the terminal.

Modes:
  opencode                        Interactive session
  opencode chat                   Interactive session (explicit)
  opencode "write a unit test"    One-shot prompt (non-interactive)
  echo "refactor this" | opencode Pipe mode (read from stdin)

Commands:
  session list                    List saved sessions
  session load <id>               Resume a session
  session delete <id>             Delete a session
  config show                     Show current configuration
  config set <key> <value>        Set a configuration value
  plugin list                     List installed plugins
  plugin install <package>        Install a plugin

Options:
  -c, --config <path>             Config file path
  -m, --model <name>              Model to use
  -s, --session <id>              Session to resume
  -v, --verbose                   Verbose logging
      --no-tui                    Disable terminal UI (scripting mode)
      --json                      Output as JSON
      --version                   Print version
  -h, --help                      Print this help

Aliases:
  mesob                          Same as 'opencode'
```

---

## 3. Build Order (Dependency Graph)

The components have a natural dependency order. Building them out of sequence means stubbing or mocking unfinished dependencies.

```
Phase 1: Foundation
  Configuration System  <-- nothing depends on it, everything depends on it
  Core Types             <-- shared types used everywhere
  Utilities              <-- deepMerge, sleep, log, etc.

Phase 2: Data Layer
  Session Management    <-- depends on Config + Types
  LLM Integration       <-- depends on Config + Types
  Tool Execution        <-- depends on Config + Types (schema, registry)

Phase 3: Execution
  Core Orchestration    <-- depends on Session + LLM + Tools
  Error Handling        <-- depends on Orchestration (used within it)

Phase 4: UI
  UI Components/Layout  <-- independent of most, needs Types
  Terminal Rendering    <-- depends on UI Components

Phase 5: Native Layer
  Rust Binary           <-- independent; communicates over stdio protocol
  Protocol Bridge       <-- depends on Rust + Orchestration

Phase 6: Extensions
  Plugin Loader         <-- depends on Config + Tools + Orchestration
  TUI Plugin            <-- depends on UI Components + Plugin system

Phase 7: Packaging
  CLI Surface           <-- depends on everything above
  Distribution/Package  <-- final step
```

### 3.1 Phase Diagram

```
Phase 1         Phase 2         Phase 3         Phase 4          Phase 5-7
+--------+     +----------+     +----------+     +----------+     +---------+
| Config | --> | Session  | --> | Orchest. | --> | TUI      | --> | Rust    |
+--------+     +----------+     +----------+     +----------+     +---------+
| Types  | --> | LLM      |     | Error    |     | Render   |     | CLI     |
+--------+     +----------+     +----------+     +----------+     +---------+
| Utils  | --> | Tools    |                       | Widgets  |     | Plugins |
+--------+     +----------+                       +----------+     +---------+
```

### 3.2 What to Build When (Milestones)

```typescript
const BUILD_MILESTONES = [
    {
        milestone: "M1: Config + Core",
        components: ["Config System", "Core Types", "Utilities"],
        estimate: "2-3 days",
        testable: true,
        test: "Unit tests for config resolution, merge, validation",
    },
    {
        milestone: "M2: LLM + Tools (headless)",
        components: ["LLM Integration", "Tool Execution"],
        estimate: "5-7 days",
        testable: true,
        test: "Can send a prompt and get a response via CLI with --no-tui",
    },
    {
        milestone: "M3: Sessions (headless)",
        components: ["Session Management", "Context Windowing"],
        estimate: "2-3 days",
        testable: true,
        test: "Multi-turn conversation persists and resumes",
    },
    {
        milestone: "M4: Orchestration Loop (headless)",
        components: ["Core Orchestration", "Error Handling"],
        estimate: "5-7 days",
        testable: true,
        test: "Full assistant loop with tool calls works headless",
    },
    {
        milestone: "M5: Terminal UI (visual)",
        components: ["UI Components", "Terminal Rendering"],
        estimate: "5-7 days",
        testable: false, // visual, needs human review
        test: "Chat interface renders, input works",
    },
    {
        milestone: "M6: Rust Binary (native)",
        components: ["Rust Binary", "Protocol Bridge"],
        estimate: "3-5 days",
        testable: true,
        test: "Raw mode, resize detection, subprocess execution",
    },
    {
        milestone: "M7: Integration",
        components: ["CLI Surface", "Plugins", "Packaging"],
        estimate: "3-5 days",
        testable: true,
        test: "End-to-end: install -> run -> session -> resume",
    },
];
```

---

## 4. Testing Strategy

### 4.1 Testing Pyramid for a TUI App

```
     /\           E2E: Full pipeline (rare, expensive)
    /  \          One full test per critical path
   /    \
  /------\        Integration: Component pairs
 /        \       Config + Session, LLM + Tools, TUI + Input
/------------\    Unit: Individual functions (many, fast)
```

### 4.2 Unit Testing

Standard Jest/Vitest for everything that does not touch the terminal:

```typescript
// Config merging
test("deepMerge overwrites primitives", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3 });
    expect(result).toEqual({ a: 1, b: 3 });
});

// Tool argument validation
test("validateArgs rejects missing required field", () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    expect(() => validateArgs({}, schema)).toThrow("missing required");
});

// Context window trimming
test("trimContext removes oldest messages when over budget", () => {
    const messages = makeMessages(100);
    const trimmed = trimToBudget(messages, 1000);
    expect(trimmed.length).toBeLessThan(100);
    expect(trimmed[0].role).toBe("system"); // system prompt preserved
});
```

### 4.3 Integration Testing (Headless)

Test the orchestration loop without a terminal by using `--no-tui` mode and mock LLM:

```typescript
// Mock LLM that returns predictable tool calls
class MockLlmRouter {
    private responses: StreamEvent[][];

    constructor(scenario: "no_tools" | "single_tool" | "multi_tool") {
        this.responses = loadScenario(scenario);
    }

    async *streamCompletion(): AsyncGenerator<StreamEvent> {
        for (const event of this.responses.shift() ?? []) {
            yield event;
        }
    }
}

test("assistant loop executes tool and continues", async () => {
    const session = await createTestSession();
    const llm = new MockLlmRouter("single_tool");
    const tools = new ToolRegistry();
    tools.register(testTool);

    await runAssistantLoop({ llm, tools, session });

    // Tool result should be in messages
    const toolMessages = session.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(1);
    expect(toolMessages[0].content).toContain("result");
});
```

### 4.4 TUI Testing

Terminal UIs are notoriously hard to test. Strategy:

```typescript
// 1. Snapshot testing of RenderOutput
test("ChatMessage renders role label correctly", () => {
    const msg = new ChatMessage({ role: "user", content: "hello" });
    const output = msg.render();
    expect(output.lines[0].text).toContain("You");
});

// 2. Input handling in isolation
test("InputPrompt handles backspace", () => {
    const prompt = new InputPrompt({});
    prompt.onKey({ type: "char", char: "h" });
    prompt.onKey({ type: "char", char: "i" });
    prompt.onKey({ type: "backspace" });
    expect(prompt.getValue()).toBe("h");
});

// 3. Virtual terminal for integration tests
// Use a library like ansi-parser or xterm-headless
test("full render produces valid ANSI", () => {
    const tui = new Tui({ width: 80, height: 24, virtual: true });
    tui.render(testMessages);
    const output = tui.flush();
    expect(output).toMatch(/\u001b\[[\d;]*m/); // contains ANSI codes
    expect(countLines(output)).toBe(24);        // fills the viewport
});
```

### 4.5 Rust Binary Testing

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_protocol_roundtrip() {
        let msg = DaemonMessage::Stdin { data: "hello".into() };
        let json = serde_json::to_string(&msg).unwrap();
        let decoded: DaemonMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn test_execute_command_timeout() {
        // Spawn a command that hangs, verify timeout kills it
        let result = execute_sync(ExecRequest {
            command: "sleep".into(),
            args: vec!["60".into()],
            timeout_ms: 100,
            ..Default::default()
        });
        assert!(result.stderr.contains("Timed out"));
    }
}
```

### 4.6 End-to-End Testing

```typescript
// Smoke test: spawn the binary, send input, verify output
test("full pipeline smoke test", async () => {
    const proc = spawn("node", ["dist/cli.js", "--no-tui"], {
        stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.write("Hello?\n");
    await sleep(5000); // wait for LLM to respond
    proc.stdin.write("/exit\n");

    const output = await new Promise<string>((resolve) => {
        let data = "";
        proc.stdout.on("data", (chunk) => (data += chunk));
        proc.on("close", () => resolve(data));
    });

    expect(output).toContain("Mesob"); // bot introduces itself
    expect(output).toContain("session"); // session was saved
});
```

### 4.7 CI Pipeline

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest  # also run on windows-latest for Rust
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npx tsc --noEmit

      - name: Lint
        run: npx eslint src/

      - name: Unit + Integration tests
        run: npx vitest run

      - name: Build
        run: npm run build

      - name: Rust tests (if changed)
        run: cargo test --manifest-path rust/Cargo.toml

      - name: E2E smoke test
        run: npm run test:e2e
```

---

## 5. Distribution & Packaging

### 5.1 Package Formats

| Platform | Format | Contents |
|----------|--------|----------|
| Windows | `.exe` installer or `.zip` | `opencode.exe` (Rust binary), Node.js runtime bundled |
| macOS | `.tar.gz` or Homebrew | `opencode` binary, install script |
| Linux | `.tar.gz` or `.deb`/`.rpm` | `opencode` binary |
| npm | `npm install -g @opencode/cli` | Node.js entry point (requires Node) |

### 5.2 Install Methods

```bash
# Option A: npm global install (requires Node.js)
npm install -g @opencode/cli

# Option B: Standalone binary (bundled Node.js)
curl -fsSL https://get.opencode.dev | bash
# or
winget install opencode    # Windows

# Option C: Homebrew
brew install opencode/tap/opencode
```

### 5.3 Version Management

```typescript
function getVersion(): string {
    // Read from package.json at build time
    return "1.0.0";
}

async function checkForUpdate(): Promise<string | null> {
    try {
        const res = await fetch("https://registry.npmjs.org/@opencode/cli/latest");
        const data = await res.json();
        const latest = data.version;
        const current = getVersion();

        return compareVersions(latest, current) > 0 ? latest : null;
    } catch {
        return null; // offline -- skip
    }
}
```

### 5.4 Auto-Update

```typescript
async function autoUpdate(): Promise<boolean> {
    const latest = await checkForUpdate();
    if (!latest) return false;

    tui.showInfo(`Update available: ${getVersion()} -> ${latest}`);

    const answer = await question("Update now?", ["Yes", "No", "Remind later"]);
    if (answer === "Yes") {
        // npm install -g @opencode/cli@latest
        // or download new binary
        await exec("npm install -g @opencode/cli@latest");
        tui.showInfo("Updated. Please restart.");
        return true;
    }
    return false;
}
```

---

## 6. Development Workflow

```
Day-to-day:
  npm run dev          -> Watch mode, rebuild on changes
  npm test             -> Unit + integration tests
  npm run test:e2e     -> End-to-end smoke test (requires API key)
  npm run lint         -> ESLint + type check
  npm run build        -> Production build

Releasing:
  1. npm version patch|minor|major
  2. npm run build
  3. npm publish
  4. git push --tags
  5. GitHub Release with binaries (CI builds these)

Debugging:
  opencode --verbose              -> Full debug logging
  opencode --no-tui               -> Headless mode (pipe output)
  NODE_OPTIONS="--inspect" opencode -> Debug Node.js side
  RUST_BACKTRACE=1 opencode       -> Debug Rust side (panic trace)
```

---

## 7. Project Root Structure

```
opencode/
  src/                     -> TypeScript source
    main.ts                -> Entry point, CLI dispatch
    config/                -> Configuration System
    llm/                   -> LLM Integration
    tools/                 -> Tool Execution Sandbox
    session/               -> Session Management
    loop/                  -> Core Orchestration
    errors/                -> Error handling
    tui/                   -> UI Components & Layout
    plugins/               -> Plugin Loader

  rust/                    -> Rust binary source
    src/
      main.rs
      terminal.rs
      node.rs
      protocol.rs
      exec.rs

  plugins/                 -> Built-in plugin packages
    opencode-tui/          -> TUI plugin (terminal UI)

  tests/                   -> Integration + E2E tests
    unit/                  -> Component-level tests
    integration/           -> Multi-component tests
    e2e/                   -> Full pipeline smoke tests

  scripts/                 -> Build & CI scripts
    build.js               -> Build orchestration
    dev.js                 -> Watch mode
    package.js             -> Binary bundling

  docs/                    -> Documentation (minimal, user-facing)
    ARCHITECTURE.md        -> High-level overview
    CONTRIBUTING.md        -> How to contribute
    CHANGELOG.md           -> Release notes

  package.json
  tsconfig.json
  vitest.config.ts
  Cargo.toml
  .github/workflows/ci.yml
```

---

## 8. Key Decisions

| Decision | Rationale |
|----------|-----------|
| One-shot mode reads from positional args or stdin | Scriptable; fits Unix philosophy of piping |
| `--no-tui` for headless mode | Essential for CI, scripting, and initial development (build LLM loop before TUI) |
| `mesob` as a symlink/wrapper, not a separate binary | One binary to maintain; alias for ease of use |
| Testing pyramid: many units, few E2E | Terminal UI E2E is slow and flaky; unit test the logic |
| Virtual terminal for TUI tests | Avoids needing a real terminal in CI; tests ANSI output as strings |
| Rust tests separate from JS tests | Different runners, different schedules; Rust tests on native changes only |
| Auto-update is opt-in, non-blocking | Never force an update mid-session; offer and move on |
| npm + standalone binary distributions | npm for Node.js users, standalone for everyone else |

---

## 9. Files

```
src/
  cli/
    parser.ts            -- CLI argument parsing
    dispatch.ts          -- mode dispatch (interactive/oneshot/subcommand)
    help.ts              -- help text generation
    version.ts           -- version info
    one-shot.ts          -- non-interactive execution
    subcommands/
      session.ts         -- /session list|load|delete
      config.ts          -- /config show|set
      plugin.ts          -- /plugin list|install

  dev/
    build-order.ts       -- milestone definitions
    testing.ts           -- test utilities, mock factories

tests/
  helpers/
    mock-llm.ts          -- MockLlmRouter with scenarios
    mock-tools.ts        -- test-only tool definitions
    virtual-tui.ts       -- VirtualTui for ANSI testing
    test-session.ts      -- createTestSession helper
    fixtures/            -- sample sessions, configs, prompts

scripts/
  dev.js
  build.js
  package.js
  release.js
```
