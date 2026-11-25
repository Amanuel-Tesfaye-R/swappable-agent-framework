# Blueprint: Terminal Rendering Engine (@opentui/core)

> A virtual component tree that renders to terminal escape codes. Layout, text styling, input handling, and incremental repainting.

---

## 1. Responsibility

The rendering engine is the lowest-level UI layer. It:

- Manages a tree of lightweight virtual components
- Computes layout (flexbox model, within terminal constraints)
- Generates ANSI/terminal escape codes for output
- Tracks which parts of the screen have changed and repaints only those
- Handles terminal input (keyboard, mouse, resize events)

---

## 2. Core Types

```typescript
// --- Component Types ---
type ComponentType = "box" | "text" | "input" | "canvas";

interface ComponentNode {
    id: number;
    type: ComponentType;
    parent: ComponentNode | null;
    children: ComponentNode[];
    props: Record<string, any>;
    style: Style;
    content?: string | (() => string);  // static or reactive
    measured: MeasuredSize | null;
    dirty: boolean;
}

interface Style {
    flexDirection?: "row" | "column";
    width?: number | "auto" | "fill";
    height?: number | "auto" | "fill";
    minWidth?: number;
    minHeight?: number;
    padding?: number | [number, number, number, number];
    margin?: number | [number, number, number, number];
    fg?: string;           // foreground color (hex or named)
    bg?: string;           // background color
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    align?: "left" | "center" | "right";
    wrap?: boolean;
}

interface MeasuredSize {
    width: number;
    height: number;
    children: MeasuredSize[];
}

// --- Render Output ---
interface RenderOp {
    type: "text" | "move" | "color" | "clear" | "cursor";
    data: string;
    row: number;
    col: number;
}
```

---

## 3. Architecture

```
Component Tree (built by app / plugins)
    |
    v
+-------------------+
|  Layout Engine    |  flexbox layout computation
|  (measure + arrange) |
+-------------------+
    |
    v
+-------------------+
|  Diff Tracker     |  compares old vs new layout
+-------------------+
    |
    v
+-------------------+
|  Escape Code Gen  |  generates minimal ANSI sequences
+-------------------+
    |
    v
+-------------------+
|  Terminal I/O     |  writes to stdout, reads from stdin
+-------------------+
    |
    v
+-------------------+
|  Input Handler    |  parses keyboard/mouse/resize events
+-------------------+
```

---

## 4. Component Tree

### 4.1 Creating Nodes

```typescript
class Renderer {
    private nextId = 1;
    private root: ComponentNode;
    private terminalSize: { width: number; height: number };
    private screen: string[][];  // current screen buffer for diffing

    createElement(type: ComponentType, props?: Record<string, any>): ComponentNode {
        return {
            id: this.nextId++,
            type,
            parent: null,
            children: [],
            props: props || {},
            style: {},
            dirty: true,
            measured: null,
        };
    }

    insert(parent: ComponentNode, child: ComponentNode | ComponentNode[]): void {
        const children = Array.isArray(child) ? child : [child];
        for (const c of children) {
            c.parent = parent;
            parent.children.push(c);
        }
        this.markDirty(parent);
    }

    setProp(node: ComponentNode, key: string, value: any): void {
        if (key === "fg" || key === "bg" || key === "bold" || key === "flexDirection") {
            // Style property
            node.style[key] = value;
        } else {
            node.props[key] = value;
        }
        this.markDirty(node);
    }
}
```

### 4.2 Reactive Content

Content can be static (a string) or reactive (a getter function):

```typescript
type ContentGetter = () => string;

function setContent(node: ComponentNode, getter: string | ContentGetter): void {
    if (typeof getter === "string") {
        node.content = getter;
    } else {
        node.content = getter;
        // Store the getter separately for re-evaluation
        node.props.__getter = getter;
    }
    this.markDirty(node);
}
```

---

## 5. Layout Engine

### 5.1 Flexbox Model (Simplified)

The layout engine implements a minimal subset of CSS flexbox:

1. **Measure phase**: Walk the tree bottom-up, computing each node's natural size
2. **Arrange phase**: Walk top-down, assigning each node its final position

```
measure(node):
    if node.type == "text":
        node.measured = measureText(node.content(), node.style)
                      = { width: text.length, height: 1 }
    else:
        for child in node.children:
            measure(child)
        node.measured = combine(child.measured, node.style, node.props)

arrange(node, x, y, availableWidth, availableHeight):
    node.position = { x, y }
    for child in node.children:
        arrange(child, child.x, child.y, child.width, child.height)
```

### 5.2 Text Measurement

```typescript
function measureText(content: string, style: Style): MeasuredSize {
    // Each character is 1 cell wide (CJK = 2, handle separately)
    const lines = content.split("\n");
    if (style.wrap) {
        const maxWidth = style.width || Infinity;
        const wrapped = wrapLines(lines, maxWidth);
        return {
            width: Math.max(...wrapped.map(l => l.length)),
            height: wrapped.length,
        };
    }
    return {
        width: Math.max(...lines.map(l => l.length)),
        height: lines.length,
    };
}
```

### 5.3 Color Representation

```typescript
// Colors stored as strings, converted to ANSI at render time
function colorToAnsi(color: string, isBg: boolean): string {
    const prefix = isBg ? "\x1b[48;2;" : "\x1b[38;2;";
    if (color.startsWith("#")) {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        return `${prefix}${r};${g};${b}m`;
    }
    // Named colors
    const map: Record<string, string> = {
        "red": "\x1b[31m",
        "green": "\x1b[32m",
        // ...
    };
    return map[color] || "\x1b[0m";
}
```

---

## 6. Diff Tracker

### 6.1 Dirty Flag Propagation

When a node is marked dirty, all ancestors are also marked dirty:

```typescript
markDirty(node: ComponentNode): void {
    if (node.dirty) return;  // already dirty
    node.dirty = true;
    if (node.parent) this.markDirty(node.parent);
}
```

### 6.2 Screen Buffer Diffing

The engine maintains a 2D array representing the current screen content. On each render pass:

```typescript
render(): RenderOp[] {
    // 1. Re-evaluate reactive content
    this.evaluateGetters(this.root);

    // 2. Recompute layout for dirty subtrees
    if (this.root.dirty) {
        this.measure(this.root);
        this.arrange(this.root, 0, 0, this.terminalSize.width, this.terminalSize.height);
    }

    // 3. Generate render ops by comparing new layout to old screen buffer
    const ops: RenderOp[] = [];
    this.diffNode(this.root, ops);

    // 4. Clear dirty flags
    this.clearDirty(this.root);

    return ops;
}
```

---

## 7. Escape Code Generation

### 7.1 ANSI Escape Sequences Used

```typescript
const ESC = {
    // Cursor
    hide: "\x1b[?25l",
    show: "\x1b[?25h",
    move: (row: number, col: number) => `\x1b[${row};${col}H`,
    up: (n: number) => `\x1b[${n}A`,
    down: (n: number) => `\x1b[${n}B`,
    right: (n: number) => `\x1b[${n}C`,
    left: (n: number) => `\x1b[${n}D`,

    // Colors
    fg: (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`,
    bg: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,
    reset: "\x1b[0m",

    // Clearing
    clearLine: "\x1b[2K",
    clearScreen: "\x1b[2J",

    // Alternate screen (full-screen apps)
    enterAlt: "\x1b[?1049h",
    exitAlt: "\x1b[?1049l",

    // Input modes
    rawMode: "\x1b[?25l",  // hide cursor for TUI
    mouseOn: "\x1b[?1000h\x1b[?1002h",  // enable mouse tracking
    mouseOff: "\x1b[?1000l\x1b[?1002l",

    // Terminal title
    title: (t: string) => `\x1b]0;${t}\x07`,
};
```

### 7.2 Minimising Output

The engine generates **only the ops needed to change the current screen** to the desired state:

```typescript
function diffScreen(
    oldScreen: string[][],
    newScreen: string[][]
): RenderOp[] {
    const ops: RenderOp[] = [];
    for (let row = 0; row < newScreen.length; row++) {
        for (let col = 0; col < newScreen[row].length; col++) {
            if (oldScreen[row]?.[col] !== newScreen[row][col]) {
                ops.push({
                    type: "text",
                    row: row + 1,
                    col: col + 1,
                    data: newScreen[row][col],
                });
            }
        }
    }
    return optimizeOps(ops);  // merge adjacent ops into runs
}
```

---

## 8. Input Handling

### 8.1 Raw Mode

The terminal must be set to raw mode to receive keystrokes without buffering:

```typescript
// Windows (PowerShell/.NET):
[DllImport("kernel32.dll")]
static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);

const uint ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const uint ENABLE_WINDOW_INPUT = 0x0008;
const uint ENABLE_MOUSE_INPUT = 0x0010;
const uint ENABLE_EXTENDED_FLAGS = 0x0080;

// Unix (termios):
struct termios {
    tcflag_t c_iflag;
    tcflag_t c_oflag;
    tcflag_t c_cflag;
    tcflag_t c_lflag;
    cc_t c_cc[NCCS];
};
tcgetattr(STDIN_FILENO, &t);
t.c_lflag &= ~(ECHO | ICANON | ISIG);
t.c_cc[VMIN] = 1;
t.c_cc[VTIME] = 0;
tcsetattr(STDIN_FILENO, TCSAFLUSH, &t);
```

### 8.2 Key Event Parsing

```
Normal keys:        'a', 'b', '1', '\n', '\t', '\x7f'
Ctrl+letter:        '\x01' to '\x1a' (Ctrl+A = 1, Ctrl+Z = 26)
Alt+letter:         '\x1b' + 'a'
Arrow keys:         '\x1b[A' up, '\x1b[B' down, '\x1b[C' right, '\x1b[D' left
Home/End:           '\x1b[H', '\x1b[F'
Page Up/Down:       '\x1b[5~', '\x1b[6~'
Delete:             '\x1b[3~'
Mouse click:        '\x1b[<0;x;yM' press, '\x1b[<0;x;ym' release
```

```typescript
function parseKey(seq: string): KeyEvent | null {
    if (seq.length === 1) {
        if (seq === "\x7f") return { type: "backspace" };
        if (seq === "\t") return { type: "tab" };
        if (seq >= "\x01" && seq <= "\x1a") {
            return { type: "ctrl", ctrl: String.fromCharCode(seq.charCodeAt(0) + 96) };
        }
        return { type: "char", char: seq };
    }
    if (seq.startsWith("\x1b[")) {
        const rest = seq.slice(2);
        switch (rest) {
            case "A": return { type: "arrow", dir: "up" };
            case "B": return { type: "arrow", dir: "down" };
            case "C": return { type: "arrow", dir: "right" };
            case "D": return { type: "arrow", dir: "left" };
            case "H": return { type: "home" };
            case "F": return { type: "end" };
            case "3~": return { type: "delete" };
            case "5~": return { type: "pageup" };
            case "6~": return { type: "pagedown" };
        }
    }
    return null;  // unknown sequence
}
```

### 8.3 Event Loop

```typescript
async function runEventLoop(renderer: Renderer, onKey: (key: KeyEvent) => void) {
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    let buffer = "";

    stdin.on("data", (chunk: string) => {
        buffer += chunk;
        // Try to parse complete sequences
        while (buffer.length > 0) {
            const key = parseKey(buffer);
            if (key) {
                onKey(key);
                buffer = buffer.slice(getSeqLength(key));
            } else {
                // Incomplete sequence, wait for more data
                break;
            }
        }
    });

    stdout.on("resize", () => {
        const { rows, cols } = stdout;
        renderer.resize(cols, rows);
    });
}
```

---

## 9. Incremental Repainting

Only changed regions of the screen are re-rendered:

```typescript
function renderFrame(renderer: Renderer): void {
    const ops = renderer.render();
    let output = "";
    let lastRow = -1;
    let lastCol = -1;

    for (const op of ops) {
        if (op.type === "move" || (op.row !== lastRow || op.col !== lastCol)) {
            output += ESC.move(op.row, op.col);
        }
        output += op.data;
        lastRow = op.row;
        lastCol = op.col + op.data.length;
    }

    write.stdout(output);
}
```

---

## 10. Key Decisions

| Decision | Rationale |
|----------|-----------|
| Own layout engine (not CSS) | Terminal is fixed-width, no complex box model needed |
| Dirty flag propagation | Avoids full tree walks on every frame |
| Screen buffer diffing | Minimises escape codes written to terminal (performance) |
| Raw mode input | Required for single-keypress handling |
| ANSI escape codes | Universal across modern terminals (no ncurses dependency) |
| No GPU/WebGL | Terminal is a character grid, not a pixel surface |

---

## 11. Files

```
src/
  renderer/
    component.ts     -- ComponentNode type, createElement, insert, setProp
    layout.ts        -- flexbox measure + arrange
    text.ts          -- text measurement, wrapping, truncation
    color.ts         -- color parsing and ANSI conversion
    diff.ts          -- screen buffer diffing
    escape.ts        -- ANSI escape sequence constants
    input.ts         -- raw mode, key parsing, event loop
    renderer.ts      -- main Renderer class
    screen.ts        -- screen buffer (2D array of cells with attributes)
    types.ts         -- shared types
```

---

## 12. Performance Targets

| Metric | Target |
|--------|--------|
| Initial render | < 50ms |
| Incremental repaint | < 10ms |
| Keypress latency | < 5ms |
| Memory per 1000 nodes | < 5MB |
| Escape code overhead | < 20% of total output |
