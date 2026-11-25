# Blueprint: Session Management

> How conversation state, history, and context are managed across a single session and across sessions -- persistence, windowing, serialization, and resumption.

---

## 1. Responsibility

Session Management owns everything related to conversational state:

- Maintaining the ordered list of messages (system, user, assistant, tool)
- Managing context window limits (trimming old messages)
- Persisting sessions to disk for resume capability
- Loading previous sessions
- Tracking metadata (model used, timestamps, token usage, tool calls)
- Providing an audit trail of everything that happened in a conversation

---

## 2. Core Types

```typescript
// --- Session Identity ---
interface SessionMeta {
    id: string;                         // UUID v4
    createdAt: string;                  // ISO 8601
    updatedAt: string;                  // ISO 8601
    title?: string;                     // auto-generated or user-set
    projectRoot?: string;               // the working directory
    model: string;                      // model ID used
    totalTokens: number;                // running total
    totalCost: number;                  // estimated USD
    messageCount: number;
}

// --- Message ---
interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    timestamp: string;                  // ISO 8601

    // For assistant messages with tool calls
    tool_calls?: ToolCall[];

    // For tool result messages
    tool_call_id?: string;
    name?: string;

    // Metadata for UI rendering
    hidden?: boolean;                   // system prompts, internal messages
    streaming?: boolean;                // message is still being generated
}

interface ToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;              // JSON string
    };
}

// --- Session File ---
interface SessionFile {
    formatVersion: 1;
    meta: SessionMeta;
    messages: Message[];
    toolHistory: ToolExecutionRecord[]; // from the auditor
}

// --- Context Budget ---
interface ContextBudget {
    maxTokens: number;                  // model's context window
    reservedForOutput: number;          // tokens reserved for model response
    safetyMargin: number;               // buffer (usually 1000)
    availableForMessages: number;       // calculated: max - reserved - margin
    currentUsage: number;               // estimated tokens in current messages
    remaining: number;                  // available - current
}
```

---

## 3. Architecture

```
+---------------------------+
| Session Manager           |
| - create, load, save      |
| - append messages         |
| - calculate context       |
| - trim when needed        |
+---------------------------+
    |
    v
+---------------------------+
| Context Windower          |
| - count tokens            |
| - decide what to trim     |
| - oldest-first removal    |
| - summary compaction?     |
+---------------------------+
    |
    v
+---------------------------+
| Session Persistence       |
| - read/write JSON files   |
| - manage session dir      |
| - list/delete sessions    |
+---------------------------+
    |
    v
+---------------------------+
| File System               |
| ~/.opencode/sessions/     |
|   <session-id>.json       |
+---------------------------+
```

---

## 4. Session Lifecycle

### 4.1 Creating a Session

```typescript
class SessionManager {
    private session: SessionFile;
    private persistence: SessionPersistence;

    async create(projectRoot?: string, model?: string): Promise<SessionFile> {
        const meta: SessionMeta = {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            projectRoot,
            model: model ?? "default",
            totalTokens: 0,
            totalCost: 0,
            messageCount: 0,
        };

        this.session = {
            formatVersion: 1,
            meta,
            messages: [],
            toolHistory: [],
        };

        // Auto-save after creation
        await this.persistence.save(this.session);

        return this.session;
    }
}
```

### 4.2 Appending Messages

```typescript
async append(message: Message): Promise<void> {
    this.session.messages.push(message);
    this.session.meta.messageCount++;
    this.session.meta.updatedAt = new Date().toISOString();

    // Estimate token cost (approximate)
    const tokenCost = estimateTokens(message.content);
    this.session.meta.totalTokens += tokenCost;

    // Auto-save after each append (debounced)
    this.scheduleAutoSave();

    // Check if we need to trim context
    await this.ensureContextBudget();
}
```

### 4.3 Loading a Session

```typescript
async load(sessionId: string): Promise<SessionFile | null> {
    const filePath = this.persistence.getPath(sessionId);
    if (!fs.existsSync(filePath)) {
        return null;
    }

    const raw = await fs.readFile(filePath, "utf-8");
    const session: SessionFile = JSON.parse(raw);

    // Version migration could happen here
    if (session.formatVersion < CURRENT_VERSION) {
        session = this.migrate(session);
    }

    this.session = session;
    return session;
}
```

### 4.4 Listing Sessions

```typescript
async list(limit: number = 20): Promise<SessionMeta[]> {
    const files = await fs.readdir(this.sessionsDir);
    const sessions: SessionMeta[] = [];

    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
            const raw = await fs.readFile(
                path.join(this.sessionsDir, file),
                "utf-8"
            );
            const session = JSON.parse(raw);
            sessions.push(session.meta);
        } catch {
            // Corrupted session file -- skip
            continue;
        }
    }

    // Sort by most recent first
    sessions.sort(
        (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return sessions.slice(0, limit);
}
```

---

## 5. Context Window Management

### 5.1 Token Counting

```typescript
function estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token for English/prose
    // Better to use actual tokenizer (tiktoken) when available
    if (USE_EXACT_TOKENIZER) {
        return tokenizer.count(text);
    }
    return Math.ceil(text.length / 4);
}

function countMessageTokens(msg: Message): number {
    let total = estimateTokens(msg.content);

    // Role markers add overhead (~4 tokens each)
    total += 4;

    // Tool calls add overhead
    if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
            total += estimateTokens(tc.function.name);
            total += estimateTokens(tc.function.arguments);
            total += 10; // structural overhead
        }
    }

    return total;
}
```

### 5.2 Context Budget Calculation

```typescript
calculateBudget(model: ModelConfig): ContextBudget {
    const reservedForOutput = model.maxTokens;
    const safetyMargin = 1000;
    const available = model.contextWindow - reservedForOutput - safetyMargin;

    let currentUsage = 0;
    for (const msg of this.session.messages) {
        currentUsage += countMessageTokens(msg);
    }

    return {
        maxTokens: model.contextWindow,
        reservedForOutput,
        safetyMargin,
        availableForMessages: available,
        currentUsage,
        remaining: available - currentUsage,
    };
}
```

### 5.3 Trimming Strategy

When the context budget is exceeded, messages must be removed. The strategy is:

```typescript
async function ensureContextBudget(): Promise<void> {
    const budget = this.calculateBudget(this.currentModel);

    if (budget.remaining >= 0) {
        return; // Everything fits
    }

    // How many tokens we need to free
    const tokensToFree = -budget.remaining + 500; // 500 token buffer

    // Start removing from the oldest messages (after system prompt)
    let freed = 0;
    const toRemove: number[] = [];

    for (let i = 1; i < this.session.messages.length - 1; i++) {
        // Never remove the last user message or system prompt
        const msg = this.session.messages[i];
        if (msg.role === "system") continue;

        const cost = countMessageTokens(msg);
        freed += cost;
        toRemove.push(i);

        if (freed >= tokensToFree) break;
    }

    // Remove messages (iterate in reverse to preserve indices)
    for (const idx of toRemove.reverse()) {
        this.session.messages.splice(idx, 1);
    }

    // Add a summary note about trimming
    this.append({
        role: "system",
        content: `[Context window trimmed: removed ${toRemove.length} older messages to free ${freed} tokens. The conversation continues with the most recent context.]`,
        timestamp: new Date().toISOString(),
        hidden: true,
    });

    this.session.meta.totalTokens -= freed;
    await this.persistence.save(this.session);
}
```

### 5.4 Alternative: Summary Compaction

For more intelligent trimming, the model can summarize older messages:

```typescript
async function summarizeAndCompact(): Promise<void> {
    // Take the oldest N messages (excluding system prompt)
    const oldestMessages = this.session.messages.slice(1, 10);

    // Ask the model to summarize them
    const summary = await this.summarizeMessages(oldestMessages);

    // Remove the old messages and insert the summary
    this.session.messages.splice(1, 10, {
        role: "system",
        content: `[Summary of earlier conversation: ${summary}]`,
        timestamp: new Date().toISOString(),
        hidden: true,
    });
}
```

---

## 6. Persistence

### 6.1 File Layout

```
~/.opencode/
  sessions/
    a1b2c3d4-e5f6-7890-abcd-ef1234567890.json
    b2c3d4e5-f6a7-8901-bcde-f12345678901.json
    latest.json          -- symlink or copy of most recent session
```

### 6.2 Session File Format

```json
{
    "formatVersion": 1,
    "meta": {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "createdAt": "2026-07-23T14:30:00.000Z",
        "updatedAt": "2026-07-23T15:45:00.000Z",
        "title": "Fix login page CSS",
        "projectRoot": "C:\\Users\\amanu\\Documents\\Projects\\site",
        "model": "deepseek-v4-flash-free",
        "totalTokens": 45230,
        "totalCost": 0.0023,
        "messageCount": 47
    },
    "messages": [
        {
            "role": "system",
            "content": "You are Mesob... [system prompt]",
            "timestamp": "2026-07-23T14:30:00.000Z",
            "hidden": true
        },
        {
            "role": "user",
            "content": "Can you fix the login button?",
            "timestamp": "2026-07-23T14:30:05.000Z"
        },
        {
            "role": "assistant",
            "content": "Let me take a look at the login component.",
            "timestamp": "2026-07-23T14:30:06.000Z"
        }
    ],
    "toolHistory": [
        {
            "name": "read",
            "timestamp": 1721745006000,
            "durationMs": 12,
            "success": true,
            "resultSize": 2340
        }
    ]
}
```

### 6.3 Auto-Save with Debouncing

```typescript
private autoSaveTimer: NodeJS.Timeout | null = null;

private scheduleAutoSave(): void {
    if (this.autoSaveTimer) {
        clearTimeout(this.autoSaveTimer);
    }
    this.autoSaveTimer = setTimeout(() => {
        this.persistence.save(this.session);
        this.autoSaveTimer = null;
    }, 2000); // 2 second debounce
}
```

### 6.4 Session Migration

```typescript
migrate(session: SessionFile): SessionFile {
    if (session.formatVersion === 1) {
        // No migration needed yet
        return session;
    }

    // Future migrations:
    // if (session.formatVersion === 1) {
    //     session = migrateV1ToV2(session);
    // }
    // if (session.formatVersion === 2) {
    //     session = migrateV2ToV3(session);
    // }

    return session;
}
```

---

## 7. Session Commands (User-Facing)

The session manager exposes these operations to the user:

| Command | Description |
|---------|-------------|
| `/session list` | Show recent sessions with timestamps |
| `/session load <id>` | Load a previous session and continue |
| `/session save` | Force-save current session (auto-save also runs) |
| `/session rename <title>` | Set a human-readable title |
| `/session export` | Export session as JSON or Markdown |
| `/session delete <id>` | Remove a session file |
| `/clear` | Clear visible messages (keeps in history) |
| `/reset` | Start fresh but keep the session file |

---

## 8. Export / Share

```typescript
async exportAsMarkdown(sessionId: string): Promise<string> {
    const session = await this.load(sessionId);
    if (!session) return "Session not found.";

    let md = `# ${session.meta.title ?? "Untitled Session"}\n\n`;
    md += `Model: ${session.meta.model}  \n`;
    md += `Date: ${session.meta.createdAt}  \n`;
    md += `Duration: ${session.meta.messageCount} messages  \n\n`;
    md += `---\n\n`;

    for (const msg of session.messages) {
        if (msg.hidden) continue;

        switch (msg.role) {
            case "user":
                md += `## User\n\n${msg.content}\n\n`;
                break;
            case "assistant":
                md += `## Assistant\n\n${msg.content}\n\n`;
                break;
            case "tool":
                md += `### Tool: ${msg.name}\n\n\`\`\`\n${msg.content}\n\`\`\`\n\n`;
                break;
        }
    }

    return md;
}
```

---

## 9. Key Decisions

| Decision | Rationale |
|----------|-----------|
| JSON file per session | Simple, human-readable, no database dependency |
| Auto-save with debounce | Balances durability vs write frequency |
| Context trimming = oldest-first removal | Simple, predictable, works well enough |
| Hidden system messages for trim notes | User sees why history was shortened |
| ~4 chars/token estimation | Fast; exact counting is done lazily on API calls |
| Format version field | Enables future migration without breaking old files |
| `latest.json` symlink | Quick access to "continue where I left off" |

---

## 10. Files

```
src/
  session/
    manager.ts           -- SessionManager: create, load, save, append
    windower.ts          -- ContextBudget, token counting, trimming
    persistence.ts       -- read/write/delete/list session files
    migration.ts         -- version migration logic
    export.ts            -- markdown/JSON export
    types.ts             -- Message, SessionMeta, SessionFile, ContextBudget
```
