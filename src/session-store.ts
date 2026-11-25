import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Message, SessionState, SwapEvent, TokenUsage } from "./types.js";

/**
 * Model-agnostic session persistence store.
 * Maintains unified conversation history and token accounting across power-source swaps.
 */
export class SessionStore {
  private readonly storageDir: string | null;
  private sessions = new Map<string, SessionState>();

  constructor(storageDir?: string) {
    this.storageDir = storageDir ? path.resolve(storageDir) : null;
    if (this.storageDir && !fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  create(agentName: string, activeProvider: string, sessionId?: string): SessionState {
    const id = sessionId || crypto.randomUUID();
    const now = new Date().toISOString();
    const state: SessionState = {
      sessionId: id,
      agentName,
      activeProvider,
      messages: [],
      swaps: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, state);
    this.persist(state);
    return state;
  }

  get(sessionId: string): SessionState | undefined {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    if (!this.storageDir) return undefined;
    const filePath = this.getFilePath(sessionId);
    if (!fs.existsSync(filePath)) return undefined;

    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionState;
    this.sessions.set(sessionId, loaded);
    return loaded;
  }

  getOrCreate(sessionId: string, agentName: string, activeProvider: string): SessionState {
    return this.get(sessionId) ?? this.create(agentName, activeProvider, sessionId);
  }

  appendMessage(sessionId: string, message: Message, usage?: TokenUsage): SessionState {
    const state = this.requireSession(sessionId);
    state.messages.push(message);
    if (usage) {
      state.totalUsage.inputTokens += usage.inputTokens;
      state.totalUsage.outputTokens += usage.outputTokens;
      state.totalUsage.totalTokens += usage.totalTokens;
    }
    state.updatedAt = new Date().toISOString();
    this.persist(state);
    return state;
  }

  recordSwap(sessionId: string, toProvider: string, reason?: string): SwapEvent {
    const state = this.requireSession(sessionId);
    const event: SwapEvent = {
      fromProvider: state.activeProvider,
      toProvider,
      reason,
      timestamp: new Date().toISOString(),
      messageIndex: state.messages.length,
    };
    state.activeProvider = toProvider;
    state.swaps.push(event);
    state.updatedAt = event.timestamp;
    this.persist(state);
    return event;
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.get(sessionId);
    if (!state) {
      throw new Error(`Session '${sessionId}' not found.`);
    }
    return state;
  }

  private getFilePath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.storageDir!, `${safeId}.json`);
  }

  private persist(state: SessionState): void {
    if (!this.storageDir) return;
    fs.writeFileSync(this.getFilePath(state.sessionId), JSON.stringify(state, null, 2), "utf-8");
  }
}
