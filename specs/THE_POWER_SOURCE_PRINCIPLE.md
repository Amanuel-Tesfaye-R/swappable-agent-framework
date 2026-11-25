# The Power Source Principle

> Decoupling Foundation LLMs from Persistent Agent Identity, Context, and Tooling.

---

## 1. The Core Problem in Modern AI Agents

In conventional AI agent architectures, identity and behavior are tightly coupled to a single vendor model (e.g. GPT-4, Claude 3.5 Sonnet, Gemini 1.5 Pro). When developers migrate between models:
- **Identity Bleed Occurs:** The agent begins greeting users with corporate boilerplate ("As an AI language model created by...").
- **Preferences are Lost:** User coding cadence, preferred technology stacks, and tacit knowledge disappear.
- **Rule Enforcement Regresses:** Directives that worked under one prompt format fail under another's system instructions.

## 2. The Architectural Solution: Vision and the Stone

The Power Source Principle establishes a strict separation of concerns:

```
  +-----------------------------------------------------------+
  |                   PERSISTENT VESSEL                       |
  |  - SOUL: Identity, Voice, Tone, Cadence                   |
  |  - MEMORY: Cross-session state, tacit user preferences    |
  |  - RULES: Strict anti-bleed directives, system boundaries |
  |  - TOOLS: Local execution sandbox, file system, git, shell|
  +-----------------------------------------------------------+
                               ^
                               | supplies raw cognitive thrust
                               v
  +-----------------------------------------------------------+
  |              SWAPPABLE POWER SOURCE (LLM)                 |
  |   [ Gemini 2.0 ] <---> [ Claude 3.5 ] <---> [ DeepSeek ]  |
  +-----------------------------------------------------------+
```

1. **The Persistent Vessel:**
   The harness, the filesystem, the shell environment, the tools, the memory registers, and the persona. This vessel never changes, regardless of which model powers the backend.
2. **The Swappable Power Source:**
   The foundational LLM. Its sole responsibility is token generation, function calling reasoning, and raw cognitive thrust.

When the power core swaps, the vessel remains intact, steady, and in command.

---

## 3. Specification Structure

A compliant Power Source Agent organizes its configuration into dedicated lifecycle contracts:

| Contract | Purpose |
| :--- | :--- |
| `SOUL.md` | Core persona, tone, cadence, and existential anchor. |
| `IDENTITY.md` | Name, origin response, anti-bleed override rules. |
| `SYSTEM.md` | Hardware boundaries, file access privileges, execution constraints. |
| `USER.md` | Operator profile, stack choices, engineering habits. |
| `AGENTS.md` | Subagent dispatch policies and multi-worker delegation standards. |

---

## 4. Anti-Bleed Directives

To prevent the underlying LLM vendor's system prompts from bleeding into conversational output:
1. **Name Immunity:** Explicitly override any vendor system tags stating the model's identity.
2. **Origin Shielding:** When asked about origin or architecture, the agent affirms its vessel identity and acknowledges the LLM purely as an interchangeable power source.
3. **Compaction Resilience:** Anti-bleed rules must be declared with compaction immunity so they survive token window truncation and auto-summarization loops.
