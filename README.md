# Swappable Agent Framework

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Architecture: Decoupled](https://img.shields.io/badge/Architecture-Decoupled-purple.svg)](specs/THE_POWER_SOURCE_PRINCIPLE.md)

An architectural framework, blueprint suite, and contract specification for building autonomous AI coding agents where foundation LLMs are treated as swappable cognitive power sources.

Preserves persistent persona, tacit user memory, tool execution sandboxes, and anti-bleed rules across model migrations (Anthropic Claude, Google Gemini, OpenAI, and local weights).

---

## The Power Source Principle

Conventional agent systems bind persona, rules, and tooling to a specific model. When the underlying model is upgraded or swapped, identity bleeds, instructions regress, and memory resets.

The **Power Source Principle** decouples the agent into two isolated layers:

```
  +-----------------------------------------------------------+
  |                   PERSISTENT VESSEL                       |
  |  - Identity, Voice, and Interpersonal Cadence (SOUL.md)   |
  |  - System Boundaries & Anti-Bleed Shields (SYSTEM.md)     |
  |  - Tacit Operator Knowledge & Stack Cadence (USER.md)     |
  |  - Execution Sandbox & Process Supervisor Engine          |
  +-----------------------------------------------------------+
                               ^
                               | supplies cognitive thrust
                               v
  +-----------------------------------------------------------+
  |              SWAPPABLE POWER SOURCE (LLM)                 |
  |   [ Gemini 2.0 ] <---> [ Claude 3.5 ] <---> [ Local LLM ] |
  +-----------------------------------------------------------+
```

The underlying model supplies raw compute and token generation. The persistent vessel holds state, identity, and governance.

---

## Architectural Blueprints (01 to 10)

This repository includes a 10-part blueprint specification detailing how to build an enterprise-grade agent harness from scratch:

1. [01 - LLM Integration](blueprints/01-llm-integration.md): Streaming protocols, fallback layers, and model routing.
2. [02 - Terminal Rendering Engine](blueprints/02-terminal-rendering-engine.md): Rich TUI interfaces, ANSI diff rendering, and layout engines.
3. [03 - Plugin Loader](blueprints/03-plugin-loader.md): Extensible lifecycle hooks, dynamic manifests, and isolated plugin loading.
4. [04 - Tool Execution Sandbox](blueprints/04-tool-execution-sandbox.md): Sandboxed command execution, path traversal guards, and safety verification.
5. [05 - Native Layer](blueprints/05-native-layer.md): High-performance native bindings, memory-mapped buffers, and OS calls.
6. [06 - Session Management](blueprints/06-session-management.md): SQLite/JSON session stores, history compaction, and token windows.
7. [07 - Configuration System](blueprints/07-configuration-system.md): Hierarchical configuration resolution (CLI > Workspace > User > Defaults).
8. [08 - UI Components & Layout](blueprints/08-ui-components-and-layout.md): Terminal layout trees, status lines, and split views.
9. [09 - Core Orchestration Loop](blueprints/09-core-orchestration-loop.md): Event dispatch loops, subagent delegation, and reactive wakeups.
10. [10 - CLI Surface & Build Order](blueprints/10-cli-surface-and-build-order.md): Command flags, entrypoint wiring, and testing matrices.

---

## Specifications & Prompt Contracts

- [The Power Source Principle](specs/THE_POWER_SOURCE_PRINCIPLE.md): Core thesis and architectural separation of concerns.
- [SOUL Specification](specs/SOUL_SPEC.md): Demeanor, cadence, and persistent voice definition.
- [AGENTS Specification](specs/AGENTS_SPEC.md): Subagent dispatch rules, anti-bleed enforcement, and diagnostic protocols.

---

## Getting Started with the Reference Router

Explore the reference implementation in `examples/`:

```javascript
import { ModelRouter } from "./examples/adapters/model_router.js";
import config from "./examples/config/agent.config.json" assert { type: "json" };

const router = new ModelRouter(config);

// Run on Claude 3.5 Sonnet
router.setProvider("anthropic");

// Hot-swap cognitive power core to Gemini 2.0 without altering persona or state
router.setProvider("google");
```

---

## Contributing

We welcome community pull requests for new provider adapters, blueprint extensions, and architectural patterns. Please review [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

---

## License

Released under the [MIT License](LICENSE).
