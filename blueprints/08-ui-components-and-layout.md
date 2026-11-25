# Blueprint: UI Components & Layout

> The terminal UI component library -- rendering engine, built-in widgets, layout primitives, input handling, and theming.

---

## 1. Responsibility

The UI Components layer is the visible face of the application. It provides:

- A declarative component tree for building terminal interfaces
- Layout primitives (flexbox, spacing, alignment) for terminal dimensions
- Built-in widgets (chat messages, input prompt, spinner, progress, markdown)
- Input handling (keyboard, mouse, clipboard)
- Theming and styling (colors, borders, icons)
- Animation primitives (shimmer, pulsing, transitions)

This layer lives in the `opencode-tui` plugin, which implements the terminal-specific UI. The architecture is designed so a different UI (IDE extension, web interface) could replace it.

---

## 2. Architecture

```
+---------------------------+
| Application Shell         |
| - layout structure        |
| - keyboard dispatch       |
| - state management        |
+---------------------------+
    |
    v
+---------------------------+
| Component Tree            |
| - Container/Row/Column    |
| - ChatMessage             |
| - InputPrompt             |
| - StatusBar               |
| - Spinner / ProgressBar   |
| - ScrollView              |
| - MarkdownRenderer        |
+---------------------------+
    |
    v
+---------------------------+
| Layout Engine             |
| - flexbox calculations    |
| - sizing & positioning    |
| - overflow handling       |
| - scroll tracking         |
+---------------------------+
    |
    v
+---------------------------+
| Rendering Backend         |
| - escape code generation  |
| - diff-based repaint      |
| - cursor management       |
| - alt screen / scrolling  |
+---------------------------+
    |
    v
+---------------------------+
| Terminal (via Rust layer) |
+---------------------------+
```

---

## 3. Component Base

### 3.1 Component Interface

```typescript
interface Component {
    // Unique identity
    id: string;

    // Layout
    parent: Component | null;
    children: Component[];
    computed: ComputedLayout;

    // Lifecycle
    mount(): void;
    unmount(): void;
    render(): RenderOutput;
    update(props: Record<string, unknown>): void;

    // Input
    onKey?(key: KeyEvent): boolean;     // return true if handled
    onMouse?(event: MouseEvent): boolean;

    // Focus
    focusable: boolean;
    focused: boolean;
    focus(): void;
    blur(): void;
}

interface ComputedLayout {
    x: number;
    y: number;
    width: number;
    height: number;
    visible: boolean;
}

interface RenderOutput {
    // The rendered lines of this component
    lines: RenderedLine[];
    // Cursor position if this component wants it
    cursor?: { row: number; col: number };
}

interface RenderedLine {
    text: string;
    // Array of style ranges: [start, end, style]
    styles: StyleRange[];
}

interface StyleRange {
    start: number;
    end: number;
    fg?: string;       // hex or named color
    bg?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    dim?: boolean;
}
```

### 3.2 Layout Primitives

```typescript
// --- Container (basic block, fills available space) ---
class Container implements Component {
    private children: Component[] = [];
    private padding: number = 0;
    // Renders children vertically, each taking their natural height
}

// --- Row (horizontal flexbox) ---
class Row implements Component {
    private children: Component[] = [];
    // Distributes children horizontally
    // Each child gets proportional width based on flex value
}

// --- Column (vertical flexbox) ---
class Column implements Component {
    private children: Component[] = [];
    // Distributes children vertically
    // Supports: flex-start, flex-end, center, stretch
}

// --- Stack (overlay) ---
class Stack implements Component {
    private children: Component[] = [];
    // All children render at the same position (for overlays like modals)
}

// --- ScrollView ---
class ScrollView implements Component {
    private child: Component;
    private scrollOffset: number = 0;
    // Clips content to viewport, tracks scroll position
    // Only renders visible portion of child
}
```

### 3.3 Flexbox Layout Algorithm

```typescript
function computeLayout(
    container: Component,
    availableWidth: number,
    availableHeight: number
): void {
    const children = container.children;
    const totalFlex = children.reduce(
        (sum, c) => sum + (c.props?.flex ?? 0),
        0
    );

    // Phase 1: Measure fixed-size children
    let remainingWidth = availableWidth;
    let remainingHeight = availableHeight;

    for (const child of children) {
        if (child.props?.width && !child.props?.flex) {
            child.computed.width = child.props.width;
            remainingWidth -= child.props.width;
        }
        if (child.props?.height) {
            child.computed.height = child.props.height;
            remainingHeight -= child.props.height;
        }
    }

    // Phase 2: Distribute remaining space to flex children
    for (const child of children) {
        const flex = child.props?.flex ?? 0;
        if (flex > 0 && totalFlex > 0) {
            child.computed.width = Math.floor(
                (remainingWidth * flex) / totalFlex
            );
        }
    }

    // Phase 3: Position children (top-left, then offset by layout direction)
    let cursorY = 0;
    for (const child of children) {
        child.computed.x = 0;
        child.computed.y = cursorY;
        child.computed.height = child.computed.height ?? child.props?.minHeight ?? 1;
        cursorY += child.computed.height;
    }
}
```

---

## 4. Built-in Widgets

### 4.1 ChatMessage

```typescript
interface ChatMessageProps {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    timestamp: string;
    streaming?: boolean;
    isLast?: boolean;
}

class ChatMessage implements Component {
    render(): RenderOutput {
        const lines: RenderedLine[] = [];

        // Role label (colored by role)
        lines.push(this.renderRoleLabel(this.props.role));

        // Content (markdown rendered)
        const contentLines = this.renderContent(this.props.content);
        lines.push(...contentLines);

        // Streaming cursor (blinking block)
        if (this.props.streaming && this.props.isLast) {
            const lastLine = lines[lines.length - 1];
            lastLine.text += " "; // space for cursor
            lastLine.styles.push({
                start: lastLine.text.length - 1,
                end: lastLine.text.length,
                fg: this.props.role === "assistant" ? "#FFE066" : "#6C7280",
                bold: true,
            });
        }

        return { lines };
    }

    private renderRoleLabel(role: string): RenderedLine {
        const labels: Record<string, string> = {
            user: "  You",
            assistant: "  Mesob",
            system: "  System",
            tool: "  Tool",
        };

        const colors: Record<string, string> = {
            user: "#34D399",
            assistant: "#FFE066",
            system: "#6C7280",
            tool: "#60A5FA",
        };

        return {
            text: `${labels[role] ?? "  Unknown"}`,
            styles: [
                {
                    start: 0,
                    end: (labels[role] ?? "  Unknown").length,
                    fg: colors[role] ?? "#FFFFFF",
                    bold: true,
                },
            ],
        };
    }
}
```

### 4.2 InputPrompt

```typescript
interface InputPromptProps {
    prompt: string;               // e.g. "The stage is yours."
    placeholder?: string;
    value: string;
    cursorPosition: number;
    onChange: (value: string) => void;
    onSubmit: (value: string) => void;
}

class InputPrompt implements Component {
    private buffer: string = "";
    private cursorPos: number = 0;
    private history: string[] = [];
    private historyIndex: number = -1;

    onKey(key: KeyEvent): boolean {
        switch (key.type) {
            case "char":
                // Insert character at cursor
                this.buffer = this.buffer.slice(0, this.cursorPos)
                    + key.char
                    + this.buffer.slice(this.cursorPos);
                this.cursorPos++;
                return true;

            case "enter":
                this.props.onSubmit(this.buffer);
                this.history.push(this.buffer);
                this.historyIndex = -1;
                this.buffer = "";
                this.cursorPos = 0;
                return true;

            case "backspace":
                if (this.cursorPos > 0) {
                    this.buffer = this.buffer.slice(0, this.cursorPos - 1)
                        + this.buffer.slice(this.cursorPos);
                    this.cursorPos--;
                }
                return true;

            case "arrow_left":
                if (this.cursorPos > 0) this.cursorPos--;
                return true;

            case "arrow_right":
                if (this.cursorPos < this.buffer.length) this.cursorPos++;
                return true;

            case "arrow_up":
                if (this.history.length > 0) {
                    this.historyIndex = Math.max(
                        0,
                        this.historyIndex === -1
                            ? this.history.length - 1
                            : this.historyIndex - 1
                    );
                    this.buffer = this.history[this.historyIndex];
                    this.cursorPos = this.buffer.length;
                }
                return true;

            case "arrow_down":
                if (this.historyIndex >= 0) {
                    this.historyIndex++;
                    if (this.historyIndex >= this.history.length) {
                        this.historyIndex = -1;
                        this.buffer = "";
                    } else {
                        this.buffer = this.history[this.historyIndex];
                    }
                    this.cursorPos = this.buffer.length;
                }
                return true;

            case "tab":
                // Could trigger autocomplete
                return true;

            case "ctrl_c":
                this.buffer = "";
                this.cursorPos = 0;
                return true;
        }

        return false;
    }

    render(): RenderOutput {
        const lines: RenderedLine[] = [];

        // Prompt label
        const promptText = this.props.prompt ?? "> ";
        const inputText = this.buffer || this.props.placeholder || "";

        // Full line: prompt + input + cursor
        const fullText = promptText + inputText;
        const styles: StyleRange[] = [];

        // Style the prompt (dim/gold)
        styles.push({
            start: 0,
            end: promptText.length,
            fg: "#FFE066",
            bold: true,
        });

        // Style the input
        if (this.buffer) {
            styles.push({
                start: promptText.length,
                end: fullText.length,
                fg: "#E5E7EB",
            });
        } else {
            // Placeholder text (dim)
            styles.push({
                start: promptText.length,
                end: fullText.length,
                fg: "#4B5563",
                italic: true,
            });
        }

        // Cursor is a block character rendered at the cursor position
        // Handled by the rendering backend as a separate cursor position

        lines.push({
            text: fullText,
            styles,
        });

        return {
            lines,
            cursor: {
                row: 0, // relative to this component
                col: promptText.length + this.cursorPos,
            },
        };
    }
}
```

### 4.3 Spinner

```typescript
class Spinner implements Component {
    private frames = ["", "", "", "", "", ""];
    private frameIndex = 0;
    private interval: NodeJS.Timeout | null = null;
    private label: string = "";

    mount(): void {
        this.interval = setInterval(() => {
            this.frameIndex = (this.frameIndex + 1) % this.frames.length;
            this.requestRender();
        }, 80);
    }

    unmount(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    render(): RenderOutput {
        return {
            lines: [
                {
                    text: ` ${this.frames[this.frameIndex]} ${this.label}`,
                    styles: [
                        {
                            start: 0,
                            end: 1,
                            fg: "#FFE066",
                        },
                        {
                            start: 2,
                            end: 2 + this.label.length,
                            fg: "#6C7280",
                            dim: true,
                        },
                    ],
                },
            ],
        };
    }
}
```

### 4.4 StatusBar

```typescript
interface StatusBarProps {
    mode: string;                       // "insert", "command"
    modelName: string;
    tokenCount?: number;
    toolStatus?: string;
    sessionTimer?: string;
    messageCount?: number;
}

class StatusBar implements Component {
    render(): RenderOutput {
        const leftItems: string[] = [];
        const rightItems: string[] = [];

        // Left side: mode indicator
        leftItems.push(this.props.mode === "command" ? "CMD" : "INS");

        // Right side: status info
        if (this.props.messageCount) {
            rightItems.push(`${this.props.messageCount} msgs`);
        }
        if (this.props.tokenCount) {
            rightItems.push(`${this.props.tokenCount} tok`);
        }
        if (this.props.toolStatus) {
            rightItems.push(this.props.toolStatus);
        }
        rightItems.push(this.props.modelName);

        // Pad or truncate left/right to fit terminal width
        const left = leftItems.join(" | ");
        const right = rightItems.join("  ");

        const availableWidth = this.computed.width;
        const rightStart = Math.max(left.length + 2, availableWidth - right.length);

        const line = left + " ".repeat(rightStart - left.length) + right;

        return {
            lines: [
                {
                    text: line,
                    styles: [
                        // Full line: inverted colors
                        {
                            start: 0,
                            end: line.length,
                            fg: "#1A1A2E",
                            bg: "#FFE066",
                        },
                        // Separators dimmed
                        ...this.findSeparators(line).map((pos) => ({
                            start: pos,
                            end: pos + 1,
                            fg: "#1A1A2E",
                            bg: "#D4A020",
                        })),
                    ],
                },
            ],
        };
    }

    private findSeparators(text: string): number[] {
        const positions: number[] = [];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === "|") positions.push(i);
        }
        return positions;
    }
}
```

### 4.5 MarkdownRenderer

```typescript
class MarkdownRenderer implements Component {
    private parsed: MarkdownBlock[] = [];

    setContent(markdown: string): void {
        this.parsed = parseMarkdown(markdown);
    }

    render(): RenderOutput {
        const lines: RenderedLine[] = [];

        for (const block of this.parsed) {
            switch (block.type) {
                case "heading":
                    lines.push(...this.renderHeading(block));
                    break;
                case "code":
                    lines.push(...this.renderCodeBlock(block));
                    break;
                case "paragraph":
                    lines.push(...this.renderParagraph(block));
                    break;
                case "list":
                    lines.push(...this.renderList(block));
                    break;
                case "blockquote":
                    lines.push(...this.renderBlockquote(block));
                    break;
            }
        }

        return { lines };
    }

    private renderHeading(block: HeadingBlock): RenderedLine[] {
        const colors = ["#FFE066", "#FBBF24", "#F59E0B", "#D4A020"];
        const color = colors[Math.min(block.level - 1, colors.length - 1)];

        return [
            {
                text: block.text,
                styles: [
                    {
                        start: 0,
                        end: block.text.length,
                        fg: color,
                        bold: true,
                    },
                ],
            },
        ];
    }

    private renderCodeBlock(block: CodeBlock): RenderedLine[] {
        const lines: RenderedLine[] = [];
        const lang = block.language ? `[${block.language}]` : "";

        // Header line
        lines.push({
            text: `  ${lang}${" ".repeat(Math.max(0, 4 - lang.length))}`,
            styles: [{ start: 0, end: 2 + lang.length, fg: "#4B5563", dim: true }],
        });

        // Code lines
        for (const codeLine of block.code.split("\n")) {
            lines.push({
                text: `  ${codeLine}`,
                styles: [{ start: 2, end: 2 + codeLine.length, fg: "#A7B4C4" }],
            });
        }

        return lines;
    }
}
```

---

## 5. Rendering Pipeline

### 5.1 Escape Code Generation

```typescript
function renderToAnsi(output: RenderOutput, terminalWidth: number): string {
    let result = "";

    for (const line of output.lines) {
        // Truncate or pad to terminal width
        const text = line.text.slice(0, terminalWidth).padEnd(terminalWidth);

        // Build ANSI escape sequence with style spans
        let pos = 0;
        const sortedStyles = [...line.styles].sort((a, b) => a.start - b.start);

        for (const style of sortedStyles) {
            // Text before this style span (unstyled)
            if (style.start > pos) {
                result += escapeText(text.slice(pos, style.start));
            }

            // Open style
            result += styleToAnsi(style);

            // Text with style
            const end = Math.min(style.end, text.length);
            result += escapeText(text.slice(style.start, end));
            pos = end;

            // Close all styles
            result += "\u001b[0m";
        }

        // Remaining text
        if (pos < text.length) {
            result += escapeText(text.slice(pos));
        }

        result += "\n";
    }

    return result;
}

function styleToAnsi(style: StyleRange): string {
    const codes: string[] = [];

    if (style.bold) codes.push("1");
    if (style.dim) codes.push("2");
    if (style.italic) codes.push("3");
    if (style.underline) codes.push("4");

    if (style.fg) {
        // 24-bit color
        const rgb = hexToRgb(style.fg);
        codes.push(`38;2;${rgb.r};${rgb.g};${rgb.b}`);
    }

    if (style.bg) {
        const rgb = hexToRgb(style.bg);
        codes.push(`48;2;${rgb.r};${rgb.g};${rgb.b}`);
    }

    return codes.length > 0 ? `\u001b[${codes.join(";")}m` : "";
}
```

### 5.2 Diff-Based Repaint

To avoid flicker, the renderer compares the previous frame with the current one and only sends the changes:

```typescript
class DiffRenderer {
    private previousFrame: string[][] = [];

    render(nextFrame: RenderedLine[]): string {
        const nextLines = nextFrame.map((l) => this.escapeAndTruncate(l));

        // Compare line-by-line
        let output = "";

        for (let i = 0; i < Math.max(this.previousFrame.length, nextLines.length); i++) {
            const prev = this.previousFrame[i] ?? "";
            const next = nextLines[i] ?? "";

            if (prev !== next) {
                // Move cursor to line i and rewrite
                output += `\u001b[${i + 1};1H`; // move to row i+1, col 1
                output += next;
                output += "\u001b[0K"; // clear to end of line
            }
        }

        this.previousFrame = nextLines;
        return output;
    }
}
```

---

## 6. Input Dispatch

```typescript
interface KeyEvent {
    type:
        | "char"
        | "enter"
        | "backspace"
        | "tab"
        | "escape"
        | "arrow_up"
        | "arrow_down"
        | "arrow_left"
        | "arrow_right"
        | "ctrl_c"
        | "ctrl_d"
        | "ctrl_v"
        | "home"
        | "end"
        | "page_up"
        | "page_down";
    char?: string;      // for "char" type
    ctrl?: boolean;
    alt?: boolean;
    meta?: boolean;
}

class InputDispatcher {
    private buffer: string = "";
    private components: Component[] = [];
    private focusedIndex: number = 0;

    handleRawInput(data: string): void {
        const events = this.parseEscapeSequence(data);
        for (const event of events) {
            this.dispatch(event);
        }
    }

    private dispatch(event: KeyEvent): void {
        // First: give the focused component a chance
        const focused = this.components[this.focusedIndex];
        if (focused?.onKey && focused.onKey(event)) {
            return;
        }

        // Then: try global shortcuts
        if (event.type === "ctrl_c") {
            process.emit("SIGINT");
            return;
        }

        if (event.type === "ctrl_d") {
            // Exit if input is empty
            process.exit(0);
        }

        if (event.type === "tab") {
            // Cycle focus
            this.focusNext();
            return;
        }

        // Otherwise: fall through to active input component
        // (handled by focused component above)
    }

    private parseEscapeSequence(data: string): KeyEvent[] {
        // Parse ANSI escape sequences from raw terminal input
        const events: KeyEvent[] = [];
        let i = 0;

        while (i < data.length) {
            const ch = data[i];

            if (ch === "\u001b" && data[i + 1] === "[") {
                // ANSI escape sequence
                const seq = data.slice(i + 2, i + data.indexOf("~", i + 2) + 1);
                // Parse arrow keys, home, end, page up/down
                // ...
                i += seq.length + 2;
            } else if (ch === "\r") {
                events.push({ type: "enter" });
                i++;
            } else if (ch === "\b" || ch === "\x7f") {
                events.push({ type: "backspace" });
                i++;
            } else if (ch === "\t") {
                events.push({ type: "tab" });
                i++;
            } else {
                events.push({ type: "char", char: ch });
                i++;
            }
        }

        return events;
    }
}
```

---

## 7. Theming

```typescript
interface Theme {
    name: string;
    colors: {
        primary: string;
        secondary: string;
        success: string;
        warning: string;
        error: string;
        muted: string;
        background: string;
        foreground: string;
        surface: string;      // secondary background
        border: string;
    };
    styles: {
        borderRadius: number;
        borderStyle: "single" | "double" | "rounded" | "none";
        spacing: number;
    };
    icons: {
        user: string;
        assistant: string;
        system: string;
        tool: string;
        spinner: string[];
        prompt: string;
    };
}

const DARK_THEME: Theme = {
    name: "dark",
    colors: {
        primary: "#FFE066",
        secondary: "#6C7280",
        success: "#34D399",
        warning: "#FBBF24",
        error: "#EF4444",
        muted: "#4B5563",
        background: "#1A1A2E",
        foreground: "#E5E7EB",
        surface: "#252542",
        border: "#374151",
    },
    styles: {
        borderRadius: 1,
        borderStyle: "rounded",
        spacing: 1,
    },
    icons: {
        user: "",
        assistant: "",
        system: "",
        tool: "",
        spinner: ["", "", "", "", "", ""],
        prompt: "",
    },
};
```

---

## 8. Full Application Shell

The top-level component that composes the entire UI:

```typescript
class AppShell implements Component {
    private children: Component[];

    constructor() {
        this.children = [
            // Main chat area (fills all available space)
            new ScrollView({
                child: new Column({
                    children: [
                        new ChatMessage({ role: "assistant", content: "Good evening, Boss. Tea?" }),
                        new ChatMessage({ role: "user", content: "What's the damage?" }),
                        new ChatMessage({ role: "assistant", content: "...", streaming: true }),
                    ],
                }),
                flex: 1,
            }),
            // Input prompt at bottom (fixed height)
            new InputPrompt({
                prompt: "The stage is yours.",
                height: 1,
            }),
            // Status bar at very bottom (fixed height)
            new StatusBar({
                modelName: "deepseek-v4-flash-free",
                messageCount: 3,
                height: 1,
            }),
        ];
    }

    render(): RenderOutput {
        // Delegate to each child in order
        const allLines: RenderedLine[] = [];
        for (const child of this.children) {
            const output = child.render();
            allLines.push(...output.lines);
        }
        return { lines: allLines };
    }
}
```

---

## 9. Key Decisions

| Decision | Rationale |
|----------|-----------|
| Component tree with parent references | Enables event bubbling and layout queries |
| Diff-based repaint, not full redraw | Eliminates flicker, reduces escape code output |
| 24-bit color everywhere | Modern terminals support it; looks dramatically better |
| ScrollView clips rather than virtualizes | Simpler; message lists rarely exceed thousands of lines |
| Input history in memory, not disk | Fast, simple; users who want persistent history use sessions |
| Icons use simple Unicode, not Nerd Fonts | Zero font dependency; works in any terminal |
| Theme as plain object, not CSS | Terminal UIs don't need cascading; simple overrides suffice |

---

## 10. Files

```
src/
  tui/
    app.tsx                  -- AppShell (top-level layout)
    component.ts             -- Component base class + ComputedLayout
    layout.ts                -- flexbox / layout computation
    renderer.ts              -- escape code generation
    diff.ts                  -- diff-based repaint engine
    input.ts                 -- InputDispatcher, KeyEvent, escape parsing
    theme.ts                 -- Theme type + built-in themes

    widgets/
      chat-message.ts        -- ChatMessage
      input-prompt.ts        -- InputPrompt
      status-bar.ts          -- StatusBar
      spinner.ts             -- Spinner
      progress-bar.ts        -- ProgressBar
      scroll-view.ts         -- ScrollView
      markdown.ts            -- MarkdownRenderer
      divider.ts             -- Divider / separator line

    primitives/
      container.ts           -- Container (block)
      row.ts                 -- Row (horizontal flex)
      column.ts              -- Column (vertical flex)
      stack.ts               -- Stack (overlay)
      text.ts                -- Text (styled string)
      border.ts              -- bordered box
```
