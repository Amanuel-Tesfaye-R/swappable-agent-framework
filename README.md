# Swappable Agent Framework

![Swappable Agent Framework: Decouple foundation LLMs from persistent identity](.github/social-preview.png)

[![CI](https://github.com/Amanuel-Tesfaye-R/swappable-agent-framework/actions/workflows/ci.yml/badge.svg)](https://github.com/Amanuel-Tesfaye-R/swappable-agent-framework/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Installable TypeScript SDK, CLI (`saf`), and architectural blueprint suite for building autonomous AI agents where foundation LLMs act as swappable cognitive power sources.

Zero external runtime dependencies. Preserves persistent persona, tacit user memory, anti-bleed directives, and unified session state across mid-conversation hot-swaps between Anthropic Claude, Google Gemini, OpenAI (or compatible endpoints), and local Ollama models.

---

## The Power Source Principle

Conventional agent systems couple identity, behavior rules, and memory to one vendor LLM. Swapping models causes identity bleed, rule regressions, and lost context.

This framework separates the runtime into two isolated layers:

```mermaid
flowchart TD
    subgraph Vessel["Persistent Vessel (Immutable Across Swaps)"]
        Compiler["Contract Compiler: IDENTITY, SOUL, SYSTEM, AGENTS"]
        Shield["Anti-Bleed Identity Shield"]
        Sessions["SessionStore: Unified History & Token Ledger"]
    end

    Router["PowerSourceRouter (Hot-Swap & Auto-Failover)"]
    Vessel <--> Router

    Router --> Claude["Anthropic (Claude 3.5 / 4)"]
    Router --> Gemini["Google (Gemini 2.0)"]
    Router --> OpenAI["OpenAI / Compatible APIs"]
    Router --> Ollama["Ollama (Local Weights)"]
```

---

## Installation

### Install via GitHub Packages (npm)

```bash
# Point the owner scope to GitHub Packages (or add to .npmrc)
echo "@amanuel-tesfaye-r:registry=https://npm.pkg.github.com" >> .npmrc

npm install @amanuel-tesfaye-r/swappable-agent-framework
```

*(Or run directly without editing `.npmrc`: `npm install @amanuel-tesfaye-r/swappable-agent-framework --registry=https://npm.pkg.github.com`)*

### Or Clone & Build from Source

```bash
git clone https://github.com/Amanuel-Tesfaye-R/swappable-agent-framework.git
cd swappable-agent-framework
npm install
npm test
```

---

## CLI Usage (`saf`)

Initialize a workspace with starter contracts (`IDENTITY.md`, `SOUL.md`, `AGENTS.md`) and `agent.config.json`:

```bash
npx saf init ./my-agent
```

Compile your markdown contracts and inspect token footprint:

```bash
npx saf compile --config ./my-agent/agent.config.json
```

List registered power sources, inspect readiness with `doctor`, and hot-swap the active model:

```bash
npx saf providers --config ./my-agent/agent.config.json
npx saf doctor --config ./my-agent/agent.config.json
npx saf swap google --config ./my-agent/agent.config.json
```

Sample `saf doctor` output:

```text
=== Swappable Agent Diagnostics ===
Agent:          CoPilot
Active Core:    anthropic
Fallback Order: google -> openai -> ollama
Anti-Bleed:     enabled
Contracts:      identity, agents (~165 tokens)

Provider Readiness:
  - anthropic (claude-3-5-sonnet-20241022): [KEY SET]
  - google (gemini-2.0-flash): [KEY SET]
  - openai (gpt-4o): [MISSING OPENAI_API_KEY]
  - ollama (qwen2.5-coder:32b): [READY]
```

Run a session turn through the active power source:

```bash
npx saf ask "Audit the authentication middleware." --session audit-1
```

---

## SDK Quickstart

```typescript
import { PowerSourceRouter, SessionStore } from "@amanuel-tesfaye-r/swappable-agent-framework";
import config from "./examples/config/agent.config.json" assert { type: "json" };

const sessions = new SessionStore("./.saf-sessions");
const router = new PowerSourceRouter(config, {
  baseDir: "./examples/config",
  sessionStore: sessions,
});

// 1. Run turn on Anthropic Claude
const r1 = await router.chat("build-42", "Map out the API schema.");

// 2. Hot-swap mid-session to Google Gemini without losing history or persona
router.swapProvider("google", "build-42", "Switching to Gemini for fast context sweep");
const r2 = await router.chat("build-42", "Now generate the SQL migrations.");
```

Automatic failover is built in via `fallbackOrder`: if the active provider fails or hits quota, `PowerSourceRouter.chat()` seamlessly switches to the next configured provider and logs the swap event in `SessionStore`.

---

## Project Structure

```
swappable-agent-framework/
├── src/
│   ├── index.ts                # Public SDK exports
│   ├── types.ts                # Core interfaces and schemas
│   ├── contract-compiler.ts    # Contract loader, precedence order, anti-bleed shield
│   ├── session-store.ts        # Persistent history, swap ledger, token tracking
│   ├── router.ts               # PowerSourceRouter with hot-swap and fallback chain
│   ├── cli.ts                  # `saf` CLI binary
│   └── adapters/
│       ├── anthropic.ts        # Anthropic Messages API adapter
│       ├── google.ts           # Google Gemini REST API adapter
│       ├── openai.ts           # OpenAI & OpenAI-compatible adapter
│       └── ollama.ts           # Local Ollama adapter
├── tests/                      # Unit tests (node --test)
├── specs/                      # Power Source Principle & contract specifications
├── blueprints/                 # 10-part full agent harness blueprints
└── examples/                   # Working config and hot-swap scripts
```

---

## Architectural Blueprints (01 to 10)

Beyond the core SDK, `blueprints/` documents the complete 10-part architecture for building an enterprise terminal agent harness:

1. [01 - LLM Integration](blueprints/01-llm-integration.md)
2. [02 - Terminal Rendering Engine](blueprints/02-terminal-rendering-engine.md)
3. [03 - Plugin Loader](blueprints/03-plugin-loader.md)
4. [04 - Tool Execution Sandbox](blueprints/04-tool-execution-sandbox.md)
5. [05 - Native Layer](blueprints/05-native-layer.md)
6. [06 - Session Management](blueprints/06-session-management.md)
7. [07 - Configuration System](blueprints/07-configuration-system.md)
8. [08 - UI Components & Layout](blueprints/08-ui-components-and-layout.md)
9. [09 - Core Orchestration Loop](blueprints/09-core-orchestration-loop.md)
10. [10 - CLI Surface & Build Order](blueprints/10-cli-surface-and-build-order.md)

---

## Companion Project

Runs seamlessly alongside [Reach](https://github.com/Amanuel-Tesfaye-R/reach) (`@amanuel-tesfaye-r/reach`), keeping your desktop AI agent and workstation reachable from Telegram 24/7.

---

## Contributing

Pull requests for additional provider adapters (Mistral, Bedrock, Cohere), streaming parsers, and blueprint extensions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

---

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-2563eb?style=for-the-badge&labelColor=0f172a)](LICENSE)

Copyright © 2026 **Amanuel Tesfaye**.  
Open-source software distributed under the terms of the [MIT License](LICENSE).

| Permissions | Conditions | Limitations |
| :--- | :--- | :--- |
| Commercial use, modification, distribution, and private use | License and copyright notice must be included | No liability or warranty |
