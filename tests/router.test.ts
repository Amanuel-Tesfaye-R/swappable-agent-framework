import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PowerSourceRouter } from "../src/router.js";
import { SessionStore } from "../src/session-store.js";
import type { AgentConfig, GenerateRequest, ModelResponse, PowerSourceAdapter } from "../src/types.js";

class MockAdapter implements PowerSourceAdapter {
  constructor(
    readonly id: string,
    readonly kind: "anthropic" | "google",
    readonly model: string,
    private readonly shouldFail: boolean = false
  ) {}

  async generate(request: GenerateRequest): Promise<ModelResponse> {
    if (this.shouldFail) {
      throw new Error(`Simulated outage on ${this.id}`);
    }
    const lastUser = request.messages[request.messages.length - 1]?.content || "";
    return {
      content: `[${this.id}] echo: ${lastUser} (history=${request.messages.length})`,
      provider: this.id,
      model: this.model,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    };
  }
}

const baseConfig: AgentConfig = {
  agent: {
    name: "Shaila",
    activeProvider: "claude",
    fallbackOrder: ["gemini"],
    providers: {
      claude: { kind: "anthropic", model: "claude-3-5-sonnet" },
      gemini: { kind: "google", model: "gemini-2.0-flash" },
    },
  },
};

test("PowerSourceRouter preserves session continuity across mid-conversation hot-swaps", async () => {
  const router = new PowerSourceRouter(baseConfig, {
    contracts: { identity: "You are Shaila." },
    adapters: {
      claude: new MockAdapter("claude", "anthropic", "claude-3-5-sonnet"),
      gemini: new MockAdapter("gemini", "google", "gemini-2.0-flash"),
    },
  });

  const r1 = await router.chat("sess-1", "First turn");
  assert.equal(r1.provider, "claude");
  assert.ok(r1.content.includes("history=1"));

  // Hot-swap mid-session
  router.swapProvider("gemini", "sess-1", "User switched model");
  assert.equal(router.getActiveProvider(), "gemini");

  const r2 = await router.chat("sess-1", "Second turn");
  assert.equal(r2.provider, "gemini");
  assert.ok(r2.content.includes("history=3"));

  const session = router.getSession("sess-1")!;
  assert.equal(session.swaps.length, 1);
  assert.equal(session.swaps[0].fromProvider, "claude");
  assert.equal(session.swaps[0].toProvider, "gemini");
  assert.equal(session.totalUsage.totalTokens, 60);
});

test("PowerSourceRouter fails over automatically to fallbackOrder when primary errors", async () => {
  const router = new PowerSourceRouter(baseConfig, {
    adapters: {
      claude: new MockAdapter("claude", "anthropic", "claude-3-5-sonnet", true),
      gemini: new MockAdapter("gemini", "google", "gemini-2.0-flash", false),
    },
  });

  const res = await router.chat("sess-failover", "Survive outage");
  assert.equal(res.provider, "gemini");
  assert.equal(router.getActiveProvider(), "gemini");
});

test("SessionStore persists and reloads state from disk", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saf-sessions-"));
  try {
    const storeA = new SessionStore(tmpDir);
    storeA.create("Shaila", "claude", "disk-1");
    storeA.appendMessage("disk-1", { role: "user", content: "Hello" }, { inputTokens: 5, outputTokens: 0, totalTokens: 5 });
    storeA.recordSwap("disk-1", "gemini", "Quota switch");

    const storeB = new SessionStore(tmpDir);
    const reloaded = storeB.get("disk-1");
    assert.ok(reloaded);
    assert.equal(reloaded.activeProvider, "gemini");
    assert.equal(reloaded.messages.length, 1);
    assert.equal(reloaded.swaps.length, 1);
    assert.equal(reloaded.totalUsage.totalTokens, 5);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
