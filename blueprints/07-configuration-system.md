# Blueprint: Configuration System

> How the tool resolves configuration from multiple sources -- JSON files, environment variables, CLI flags, defaults -- and exposes it to the rest of the runtime.

---

## 1. Responsibility

The Configuration System is the single source of truth for all user-adjustable settings. It:

- Defines the schema of all valid configuration options
- Loads configuration from multiple sources with well-defined precedence
- Merges partial configurations from different sources
- Validates configuration against the schema at load time
- Provides typed access to configuration values throughout the runtime
- Supports per-project overrides via local config files
- Exposes configuration as environment variables for subprocesses

---

## 2. Core Types

```typescript
// --- Complete Configuration Shape ---
interface Config {
    // Appearance
    theme: ThemeConfig;
    colors: ColorConfig;

    // Behavior
    autoSave: boolean;
    autoSaveIntervalMs: number;
    contextWindowMargin: number;
    defaultModel: string;

    // Models
    models: Record<string, ModelProviderConfig>;

    // Tools
    tools: ToolConfig;

    // Paths
    paths: PathConfig;

    // Developer
    verbose: boolean;
    logLevel: "silent" | "error" | "warn" | "info" | "debug";
}

interface ThemeConfig {
    mode: "dark" | "light" | "auto";
    name: string;                      // built-in theme name or path to theme file
    fontFamily: string;
    fontSize: number;
}

interface ColorConfig {
    primary: string;                   // hex
    secondary: string;
    success: string;
    warning: string;
    error: string;
    muted: string;
    background: string;
    foreground: string;
}

interface ModelProviderConfig {
    id: string;
    provider: "openai" | "anthropic" | "google" | "ollama" | "custom";
    baseUrl: string;
    apiKeyEnvVar: string;
    maxTokens: number;
    contextWindow: number;
    supportsTools: boolean;
    supportsStreaming: boolean;
    costPer1kInput: number;
    costPer1kOutput: number;
}

interface ToolConfig {
    defaultTimeoutMs: number;
    maxResultSize: number;
    allowedPaths: string[];
    blockedCommands: string[];
}

interface PathConfig {
    sessionsDir: string;
    pluginsDir: string;
    cacheDir: string;
    configFile: string;
}

// --- Config Source Tracking ---
type ConfigSource = "default" | "global" | "project" | "env" | "cli" | "runtime";

interface ConfigEntry<T> {
    value: T;
    source: ConfigSource;
}

// --- Partial Config (what users write) ---
type PartialConfig = DeepPartial<Config>;
```

---

## 3. Configuration Sources & Precedence

### 3.1 Resolution Order (lowest to highest priority)

```
1.  Built-in defaults       (hardcoded in code)
2.  Global config file      (~/.opencode/config.json)
3.  Project config file     (<project-root>/.opencode.json)
4.  Environment variables   (OPENCODE_*)
5.  CLI flags               (--verbose, --model, etc.)
6.  Runtime overrides       (/set command, API calls)
```

Each higher-priority source **merges over** the lower-priority sources. Arrays are replaced, not concatenated (except `allowedPaths` which is unioned).

### 3.2 Resolution Engine

```typescript
class ConfigResolver {
    private layers: ConfigSource[] = [
        "default",
        "global",
        "project",
        "env",
        "cli",
    ];
    private resolved: Config | null = null;

    async resolve(overrides?: Partial<Config>): Promise<Config> {
        let config: Config = DEFAULT_CONFIG;

        // Layer 1: Global config
        const globalConfig = await this.loadFile(
            this.getGlobalConfigPath()
        );
        if (globalConfig) {
            config = deepMerge(config, globalConfig);
        }

        // Layer 2: Project config
        const projectConfig = await this.findAndLoadProjectConfig();
        if (projectConfig) {
            config = deepMerge(config, projectConfig);
        }

        // Layer 3: Environment variables
        config = deepMerge(config, this.fromEnvironment());

        // Layer 4: CLI flags
        config = deepMerge(config, this.fromCli());

        // Layer 5: Runtime overrides (applied at call site)
        if (overrides) {
            config = deepMerge(config, overrides);
        }

        // Validate final config
        const errors = validateConfig(config);
        if (errors.length > 0) {
            console.error("Configuration errors:");
            for (const err of errors) {
                console.error(`  - ${err}`);
            }
        }

        this.resolved = config;
        return config;
    }

    get<K extends keyof Config>(key: K): Config[K] {
        if (!this.resolved) {
            throw new Error("Config not resolved yet. Call resolve() first.");
        }
        return this.resolved[key];
    }
}
```

---

## 4. File Locations

### 4.1 Config File Search Order

```typescript
getGlobalConfigPath(): string {
    // XDG_CONFIG_HOME on Linux/Mac, APPDATA on Windows
    const base = process.env.XDG_CONFIG_HOME
        ?? path.join(process.env.HOME || "", ".config")
        ?? process.env.APPDATA
        ?? path.join(process.env.HOME || "", ".opencode");

    return path.join(base, "opencode", "config.json");
}

async findAndLoadProjectConfig(): Promise<PartialConfig | null> {
    // Walk up from cwd looking for .opencode.json
    let dir = process.cwd();
    const root = path.parse(dir).root;

    while (true) {
        const candidate = path.join(dir, ".opencode.json");
        if (fs.existsSync(candidate)) {
            return this.loadFile(candidate);
        }

        if (dir === root) break;
        dir = path.dirname(dir);
    }

    return null;
}
```

### 4.2 All Paths

```
Global config:
  Linux:   ~/.config/opencode/config.json
  macOS:   ~/Library/Application Support/opencode/config.json
  Windows: %APPDATA%/opencode/config.json

Project config:
  <project-root>/.opencode.json

Cache and data:
  Linux:   ~/.cache/opencode/  (~/.local/share/opencode/)
  macOS:   ~/Library/Caches/opencode/
  Windows: %LOCALAPPDATA%/opencode/
```

---

## 5. Deep Merge Strategy

```typescript
function deepMerge<T>(target: T, source: DeepPartial<T>): T {
    const output = { ...target };

    for (const key of Object.keys(source)) {
        const srcVal = (source as any)[key];
        const tgtVal = (target as any)[key];

        if (srcVal === undefined) continue;

        // Arrays: replace entirely (with one exception)
        if (Array.isArray(tgtVal) && Array.isArray(srcVal)) {
            if (key === "allowedPaths") {
                // Union allowedPaths instead of replacing
                output[key] = [...new Set([...tgtVal, ...srcVal])] as any;
            } else {
                output[key] = srcVal as any;
            }
            continue;
        }

        // Objects: recurse
        if (isPlainObject(tgtVal) && isPlainObject(srcVal)) {
            output[key] = deepMerge(tgtVal, srcVal);
            continue;
        }

        // Primitives: overwrite
        output[key] = srcVal as any;
    }

    return output;
}
```

---

## 6. Environment Variable Mapping

```typescript
fromEnvironment(): Partial<Config> {
    const result: Partial<Config> = {};

    // OPENCODE_MODEL -> config.defaultModel
    if (process.env.OPENCODE_MODEL) {
        result.defaultModel = process.env.OPENCODE_MODEL;
    }

    // OPENCODE_THEME -> config.theme.name
    if (process.env.OPENCODE_THEME) {
        result.theme = { name: process.env.OPENCODE_THEME };
    }

    // OPENCODE_LOG_LEVEL -> config.logLevel
    if (process.env.OPENCODE_LOG_LEVEL) {
        const level = process.env.OPENCODE_LOG_LEVEL as Config["logLevel"];
        if (["silent", "error", "warn", "info", "debug"].includes(level)) {
            result.logLevel = level;
        }
    }

    // OPENCODE_ALLOWED_PATHS (semicolon-separated)
    if (process.env.OPENCODE_ALLOWED_PATHS) {
        result.tools = {
            allowedPaths: process.env.OPENCODE_ALLOWED_PATHS.split(";"),
        };
    }

    // OPENCODE_VERBOSE
    if (process.env.OPENCODE_VERBOSE === "1" || process.env.OPENCODE_VERBOSE === "true") {
        result.verbose = true;
    }

    // OPENCODE_DISABLE_AUTO_SAVE
    if (process.env.OPENCODE_DISABLE_AUTO_SAVE === "1") {
        result.autoSave = false;
    }

    // OPENCODE_MODEL_<NAME>_BASE_URL -> override specific model's base URL
    for (const [key, value] of Object.entries(process.env)) {
        const match = key.match(/^OPENCODE_MODEL_(\w+)_BASE_URL$/);
        if (match && value) {
            const modelName = match[1].toLowerCase();
            result.models = result.models ?? {};
            result.models[modelName] = {
                ...(result.models[modelName] ?? {}),
                baseUrl: value,
            };
        }
    }

    return result;
}
```

---

## 7. Default Configuration

```typescript
const DEFAULT_CONFIG: Config = {
    theme: {
        mode: "dark",
        name: "default",
        fontFamily: "monospace",
        fontSize: 14,
    },
    colors: {
        primary: "#FFE066",       // Mesob gold
        secondary: "#6C7280",
        success: "#34D399",
        warning: "#FBBF24",
        error: "#EF4444",
        muted: "#4B5563",
        background: "#1A1A2E",
        foreground: "#E5E7EB",
    },
    autoSave: true,
    autoSaveIntervalMs: 2000,
    contextWindowMargin: 1000,
    defaultModel: "primary",
    models: {
        primary: {
            id: "gpt-4o",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnvVar: "OPENAI_API_KEY",
            maxTokens: 4096,
            contextWindow: 128000,
            supportsTools: true,
            supportsStreaming: true,
            costPer1kInput: 0.005,
            costPer1kOutput: 0.015,
        },
    },
    tools: {
        defaultTimeoutMs: 30000,
        maxResultSize: 50000,
        allowedPaths: ["."],           // defaults to cwd at resolve time
        blockedCommands: [
            "vim", "nano", "less", "more", "top", "htop",
        ],
    },
    paths: {
        // Set at resolve time based on platform
        sessionsDir: "",
        pluginsDir: "",
        cacheDir: "",
        configFile: "",
    },
    verbose: false,
    logLevel: "info",
};
```

---

## 8. Validation

```typescript
function validateConfig(config: Config): string[] {
    const errors: string[] = [];

    // Validate theme mode
    if (!["dark", "light", "auto"].includes(config.theme.mode)) {
        errors.push(`theme.mode must be "dark", "light", or "auto"`);
    }

    // Validate logLevel
    if (!["silent", "error", "warn", "info", "debug"].includes(config.logLevel)) {
        errors.push(`logLevel must be one of: silent, error, warn, info, debug`);
    }

    // Validate hex colors
    for (const [key, color] of Object.entries(config.colors)) {
        if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
            errors.push(`colors.${key}: "${color}" is not a valid hex color`);
        }
    }

    // Validate model configs
    for (const [name, model] of Object.entries(config.models)) {
        if (model.maxTokens > model.contextWindow) {
            errors.push(
                `models.${name}.maxTokens (${model.maxTokens}) exceeds contextWindow (${model.contextWindow})`
            );
        }
    }

    // Validate tools config
    if (config.tools.defaultTimeoutMs < 1000) {
        errors.push("tools.defaultTimeoutMs should be at least 1000ms");
    }

    return errors;
}
```

---

## 9. Runtime Override (The `/set` Command)

Users can change configuration mid-session with a `/set` command:

```
/set theme.mode light
/set defaultModel fast
/set logLevel debug
/set colors.primary "#FF0000"
```

```typescript
async applyRuntimeOverride(path: string, value: string): Promise<void> {
    const keys = path.split(".");
    let current: any = this.resolved;

    // Navigate to the parent of the target key
    for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in current)) {
            throw new Error(`Unknown config key: ${keys.slice(0, i + 1).join(".")}`);
        }
        current = current[keys[i]];
    }

    const lastKey = keys[keys.length - 1];
    const existing = current[lastKey];

    // Parse the value based on existing type
    if (typeof existing === "boolean") {
        current[lastKey] = value === "true" || value === "1";
    } else if (typeof existing === "number") {
        current[lastKey] = Number(value);
    } else if (typeof existing === "string") {
        current[lastKey] = value;
    } else {
        current[lastKey] = JSON.parse(value);
    }

    // Re-validate
    const errors = validateConfig(this.resolved!);
    if (errors.length > 0) {
        // Revert
        current[lastKey] = existing;
        throw new Error(`Invalid value: ${errors.join("; ")}`);
    }

    // Persist to global config (optional, user can opt in)
    await this.saveGlobalConfig(this.resolved!);
}
```

---

## 10. Key Decisions

| Decision | Rationale |
|----------|-----------|
| JSON for config files | Universal, no dependencies, comments via JSONC optional |
| Deep merge, not replace | Users can override single keys without copying the entire config |
| Path whitelist union, not replace | Safer: project and global paths both apply |
| Environment variables for CI/containers | Users need to configure without writing files |
| CLI flags for quick overrides | Most explicit, highest priority, session-specific |
| Validation at resolve time | Fail fast; don't discover invalid config mid-session |
| `/set` for runtime changes | No restart needed; useful for theme/color tweaking |

---

## 11. Files

```
src/
  config/
    resolver.ts          -- ConfigResolver: loading, merging, priority
    defaults.ts          -- DEFAULT_CONFIG constant
    schema.ts            -- TypeScript types for Config
    validation.ts        -- validateConfig() function
    env.ts               -- fromEnvironment() parser
    cli.ts               -- CLI flag definitions and parser
    paths.ts             -- platform path resolution
    runtime.ts           -- /set command handler
```
