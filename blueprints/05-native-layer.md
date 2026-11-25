# Blueprint: Rust Binary & Native Layer

> The native executable that bootstraps the runtime, manages the Node.js process, handles terminal raw mode, and provides low-level OS bindings.

---

## 1. Responsibility

The Rust binary is the entry point of the entire application. It is what the user actually executes when they run `opencode` (or `mesob`). Its jobs are:

- Bootstrap and manage the Node.js runtime process
- Put the terminal into raw mode (character-by-character input)
- Handle window resize events (SIGWINCH)
- Provide low-level OS bindings (spawn, filesystem, environment)
- Act as a stdio bridge between the terminal and the Node.js process
- Handle graceful shutdown and cleanup

This layer exists because Node.js cannot reliably manage a raw terminal on its own -- especially on Windows, where native console APIs are required.

---

## 2. Core Types

```rust
// --- Message Protocol (JSON over stdio) ---
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
enum DaemonMessage {
    #[serde(rename = "stdin")]
    Stdin { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "signal")]
    Signal { sig: String },
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "shutdown")]
    Shutdown { code: i32 },
    #[serde(rename = "exec")]
    Exec {
        id: u64,
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
        cwd: String,
        timeout_ms: u64,
    },
    #[serde(rename = "exec_result")]
    ExecResult {
        id: u64,
        stdout: String,
        stderr: String,
        exit_code: i32,
    },
    #[serde(rename = "exec_error")]
    ExecError { id: u64, error: String },
}

// --- Terminal Capabilities ---
struct TerminalInfo {
    cols: u16,
    rows: u16,
    supports_24bit_color: bool,
    supports_ansi: bool,
    is_windows: bool,
    has_alt_screen: bool,
}
```

---

## 3. Architecture

```
User runs: opencode (mesob)
    |
    v
+----------------------------+
| Rust Binary Entry Point    |
| - parse CLI args           |
| - detect terminal caps     |
| - init logging             |
+----------------------------+
    |
    v
+----------------------------+
| Terminal Raw Mode          |
| - enable raw input         |
| - disable line buffering   |
| - hide cursor              |
| - enable alt screen        |
| - register cleanup handler |
+----------------------------+
    |
    v
+----------------------------+
| Node.js Boot               |
| - find Node executable     |
| - spawn child process      |
| - pipe stdio               |
| - wait for "ready" signal  |
+----------------------------+
    |
    v
+----------------------------+
| Event Loop (Message Pump)  |
| - forward stdin -> Node    |
| - forward resize -> Node   |
| - forward signals -> Node  |
| - receive exec requests    |
| - receive shutdown         |
+----------------------------+
    |
    v
[Loop until shutdown signal]
```

---

## 4. Startup Sequence

### 4.1 CLI Argument Parsing

```rust
struct CliArgs {
    config_path: Option<PathBuf>,
    project_dir: Option<PathBuf>,
    verbose: bool,
    version: bool,
}

fn parse_args() -> CliArgs {
    let args: Vec<String> = std::env::args().collect();
    // ... standard argument parsing
}
```

### 4.2 Terminal Detection

```rust
fn detect_terminal() -> TerminalInfo {
    let mut info = TerminalInfo {
        cols: 80,
        rows: 24,
        supports_24bit_color: false,
        supports_ansi: false,
        is_windows: cfg!(windows),
        has_alt_screen: true,
    };

    // Get terminal size via ioctl/GetConsoleScreenBufferInfo
    if let Ok((cols, rows)) = terminal_size() {
        info.cols = cols;
        info.rows = rows;
    }

    // Check COLORTERM for 24-bit support
    if let Ok(colorterm) = std::env::var("COLORTERM") {
        info.supports_24bit_color = colorterm == "truecolor" || colorterm == "24bit";
    }

    // Check TERM for ANSI support
    if let Ok(term) = std::env::var("TERM") {
        info.supports_ansi = term != "dumb" && term != "";
    }

    info
}
```

### 4.3 Node.js Process Spawn

```rust
fn spawn_node(core_path: &Path, info: &TerminalInfo) -> Result<Child> {
    // Find Node.js from PATH or bundled
    let node = find_node()?;

    // Build the main entry module path
    let main = core_path.join("dist/index.js");

    // Pass terminal info via environment variables
    let envs: Vec<(&str, String)> = vec![
        ("TERMINAL_COLS", info.cols.to_string()),
        ("TERMINAL_ROWS", info.rows.to_string()),
        ("TERMINAL_24BIT", info.supports_24bit_color.to_string()),
        ("OPMODE", "daemon".to_string()),
    ];

    let child = Command::new(node)
        .arg(main)
        .envs(envs)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    Ok(child)
}
```

---

## 5. Message Protocol (JSON over stdio)

The Rust binary and Node.js process communicate over stdin/stdout using newline-delimited JSON.

### 5.1 Direction: Terminal -> Node.js

```
{"type":"stdin","data":"h"}     <- key press
{"type":"stdin","data":"\r"}   <- enter
{"type":"stdin","data":"\u001b[A"}  <- arrow up
{"type":"resize","cols":120,"rows":40}  <- window resize
{"type":"signal","sig":"ctrl_c"}
```

### 5.2 Direction: Node.js -> Terminal

```
{"type":"write","data":"\u001b[2J\u001b[H"}     <- clear screen
{"type":"write","data":"\u001b[32mHello\u001b[0m"}  <- colored text
{"type":"cursor","visible":false}                <- hide cursor
{"type":"cursor","row":10,"col":5}               <- move cursor
{"type":"shutdown","code":0}                     <- exit gracefully
{"type":"exec","id":1,"command":"ls","args":["-la"],...}  <- execute process
```

### 5.3 Why Not Node.js Directly?

The Rust layer exists to solve problems Node.js cannot handle alone:

| Problem | Rust Solution |
|---------|---------------|
| Raw terminal mode on Windows | Uses `SetConsoleMode()` Win32 API |
| Signal handling | Native OS signal handlers (SIGINT, SIGWINCH) |
| Process spawning for tools (bash, etc.) | Direct `fork()`/`CreateProcess()` without Node overhead |
| Terminal resize detection | Synchronous polling or OS event watchers |
| Startup performance | Rust binary starts in <5ms vs Node.js cold start (~100ms) |
| Graceful cleanup | Runs even if Node.js crashes; restores terminal state |

---

## 6. Raw Mode Terminal Management

### 6.1 Enabling Raw Mode (Unix)

```rust
fn enable_raw_mode() -> io::Result<TerminalGuard> {
    let mut termios = Termios::from_fd(STDIN_FILENO)?;
    let original = termios.clone();

    // Disable: echo, canonical mode, signals, extended processing
    termios.c_iflag &= !(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON);
    termios.c_oflag &= !OPOST;
    termios.c_lflag &= !(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
    termios.c_cflag &= !(CSIZE | PARENB);
    termios.c_cflag |= CS8;
    termios.c_cc[VMIN] = 1;
    termios.c_cc[VTIME] = 0;

    tcsetattr(STDIN_FILENO, TCSAFLUSH, &termios)?;

    Ok(TerminalGuard { original })
}
```

### 6.2 Enabling Raw Mode (Windows)

```rust
#[cfg(windows)]
fn enable_raw_mode() -> io::Result<TerminalGuard> {
    use windows::Win32::System::Console::*;

    let stdin_handle = GetStdHandle(STD_INPUT_HANDLE)?;
    let mut original_mode: CONSOLE_MODE = Default::default();
    GetConsoleMode(stdin_handle, &mut original_mode)?;

    // Disable: echo input, line input, processed input, window handling
    // Enable: virtual terminal input (for ANSI escape sequences)
    let new_mode = original_mode
        & !(ENABLE_ECHO_INPUT
            | ENABLE_LINE_INPUT
            | ENABLE_PROCESSED_INPUT
            | ENABLE_WINDOW_INPUT);
    // Need to add back ENABLE_VIRTUAL_TERMINAL_INPUT for modern Windows
    let vt_mode = CONSOLE_MODE(ENABLE_VIRTUAL_TERMINAL_INPUT.0);
    SetConsoleMode(stdin_handle, new_mode | vt_mode)?;

    Ok(TerminalGuard { original: original_mode })
}
```

### 6.3 Cleanup on Exit

```rust
struct TerminalGuard {
    original: Termios, // or CONSOLE_MODE on Windows
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        // Restore original terminal settings
        tcsetattr(STDIN_FILENO, TCSAFLUSH, &self.original).ok();
        // Show cursor
        write!(std::io::stdout(), "\u001b[?25h").ok();
        // Exit alt screen if active
        write!(std::io::stdout(), "\u001b[?1049l").ok();
        // Flush
        std::io::stdout().flush().ok();
    }
}
```

---

## 7. Process Execution (Tool Runtime)

The Rust binary also handles executing subprocesses for tools like `bash`. This is more efficient than going through Node.js `child_process`.

```rust
async fn execute_command(request: ExecRequest) -> ExecResponse {
    let start = Instant::now();

    let mut child = tokio::process::Command::new(&request.command)
        .args(&request.args)
        .env_clear()
        .envs(&request.env)
        .current_dir(&request.cwd)
        .stdin(Stdio::null())  // no stdin for tool commands
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();

    let result = tokio::time::timeout(
        Duration::from_millis(request.timeout_ms),
        child.wait_with_output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => ExecResponse {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Ok(Err(e)) => ExecResponse {
            stdout: String::new(),
            stderr: format!("Failed to spawn: {}", e),
            exit_code: -1,
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Err(_) => {
            // Timeout - kill the child
            child.kill().await.ok();
            ExecResponse {
                stdout: String::new(),
                stderr: format!("Timed out after {}ms", request.timeout_ms),
                exit_code: -1,
                duration_ms: request.timeout_ms,
            }
        }
    }
}
```

---

## 8. Windows-Specific Considerations

The Rust binary needs special handling on Windows:

### 8.1 Console Code Page

```rust
#[cfg(windows)]
fn ensure_utf8() {
    // Set console to UTF-8 code page
    unsafe {
        SetConsoleOutputCP(65001); // CP_UTF8
        SetConsoleCP(65001);
    }
}
```

### 8.2 Process Group Management

```rust
#[cfg(windows)]
fn create_process_group() {
    // On Windows, Ctrl+C is sent to all processes in the same console.
    // We need to handle this carefully so tool executions don't
    // terminate the parent process.
    SetConsoleCtrlHandler(None, true).ok();
}
```

### 8.3 ANSI Escape Sequence Support

Modern Windows 10+ supports ANSI escape sequences when `ENABLE_VIRTUAL_TERMINAL_INPUT` and `ENABLE_VIRTUAL_TERMINAL_PROCESSING` are set. The Rust binary enables these at startup.

---

## 9. Startup Performance Optimization

Cold start is critical. The Rust binary should:

1. **Spawn Node.js as early as possible** -- don't wait for terminal detection to finish
2. **Stream terminal info to Node.js** -- send it as the first message once detected
3. **Keep Node.js warm** -- if the user runs multiple sessions, keep Node.js in a cached state
4. **Pre-compile** `dist/index.js` with V8 code caching

```rust
fn main() {
    // Phase 1: Parse args (synchronous, fast)
    let args = CliArgs::parse();

    // Phase 2: Spawn Node.js immediately (async)
    let node_handle = thread::spawn(|| spawn_node(&args.core_path));

    // Phase 3: Detect terminal while Node.js starts (parallel)
    let terminal_info = detect_terminal();
    let terminal_guard = enable_raw_mode();

    // Phase 4: Wait for Node.js and send init message
    let mut node = node_handle.join().unwrap()?;
    send_init(&mut node, &terminal_info);

    // Phase 5: Enter event loop
    run_event_loop(&mut node, &terminal_guard)
}
```

---

## 10. Key Decisions

| Decision | Rationale |
|----------|-----------|
| JSON over stdio for IPC | Universal, debuggable, no protobuf dependency |
| Rust for raw mode, not Node.js | Node.js cannot set Windows console modes natively |
| Subprocess execution in Rust | Avoids Node.js event loop impact for long-running commands |
| TerminalGuard with Drop | Rust guarantees cleanup even on panic/abort |
| Parallel startup (spawn + detect) | Shaves ~50ms off cold start |
| Bundle Node.js or find it | bundling adds ~40MB; finding it is lighter but less reliable |
| One binary, no DLLs | Simpler distribution; Rust compiles statically by default |

---

## 11. Files

```
src/
  main.rs                -- entry point, CLI parsing
  terminal.rs            -- raw mode, terminal detection, size
  node.rs                -- Node.js process management
  protocol.rs            -- message types, serialization
  event_loop.rs          -- stdin polling, message dispatch
  exec.rs                -- subprocess execution
  signal.rs              -- OS signal handling
  cleanup.rs             -- graceful shutdown, terminal restoration
  platform/
    windows.rs           -- Windows console API bindings
    unix.rs              -- Unix termios bindings

Cargo.toml
  dependencies:
    - serde / serde_json    -- message serialization
    - tokio                 -- async subprocess execution
    - termios               -- Unix raw mode (cfg(unix))
    - windows               -- Windows API bindings (cfg(windows))
    - clap                  -- CLI argument parsing (optional)
```
