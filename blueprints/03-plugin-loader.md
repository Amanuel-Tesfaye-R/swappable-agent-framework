# Blueprint: Plugin Loader

> How to discover, load, sandbox, and manage plugins -- Node.js module resolution within a terminal application.

---

## 1. Responsibility

The plugin loader discovers and loads extension packages. It handles:

- Scanning plugin directories (system cache, user installs, global installs)
- Resolving Node.js modules in a controlled environment
- Loading plugin entry points and calling registration functions
- Version management and dependency resolution
- Sandboxing plugins (limited API access)
- Hot-reloading (reloading plugins without restarting the host)

---

## 2. Core Types

```typescript
interface PluginManifest {
    name: string;
    version: string;
    description: string;
    entryPoint: string;          // relative path to main file
    slots: string[];             // which slots this plugin hooks into
    dependencies?: Record<string, string>;
    config?: Record<string, any>;  // default configuration
}

interface PluginInstance {
    id: string;                  // "author/plugin-name"
    manifest: PluginManifest;
    directory: string;           // absolute path to plugin root
    module: any;                 // the loaded module exports
    api: PluginAPI;              // sandboxed API object passed to plugin
    state: "loaded" | "active" | "error";
    error?: Error;
}

interface PluginAPI {
    slots: SlotRegistry;
    config: ConfigAccess;
    logger: Logger;
    events: EventBus;
    fs: FsAccess;                // limited filesystem access
    http: HttpAccess;            // limited network access
}

interface SlotRegistry {
    register(slot: SlotDefinition): void;
    unregister(id: string): void;
    get(slotName: string): SlotDefinition[];
}

interface SlotDefinition {
    id: string;
    slotName: string;
    component: any;              // a component factory or render function
    priority?: number;
    metadata?: Record<string, any>;
}
```

---

## 3. Architecture

```
+---------------------------+
|    Plugin Discovery       |
|  scans directories for    |
|  package.json + manifest  |
+---------------------------+
    |
    v
+---------------------------+
|    Module Resolution      |
|  custom resolver, not     |
|  npm's node_modules walk  |
+---------------------------+
    |
    v
+---------------------------+
|    Plugin Sandbox         |
|  wraps API, limits access |
+---------------------------+
    |
    v
+---------------------------+
|    Plugin Registry        |
|  tracks loaded plugins,   |
|  manages slots, lifecycle |
+---------------------------+
    |
    v
+---------------------------+
|    Slot System            |
|  runtime extension points |
|  that plugins hook into   |
+---------------------------+
```

---

## 4. Plugin Discovery

### 4.1 Search Paths (in order)

```typescript
function findPlugins(): PluginManifest[] {
    const searchPaths = [
        // 1. System cache (fastest, managed by app)
        "~/.cache/myapp/packages/",

        // 2. User-installed plugins
        "~/.myapp/plugins/",

        // 3. Project-local plugins (if in a project directory)
        "./.myapp/plugins/",

        // 4. Global npm packages
        "/usr/local/lib/node_modules/",
        // or on Windows:
        // "%APPDATA%/npm/node_modules/",
    ];

    const manifests: PluginManifest[] = [];
    for (const dir of searchPaths) {
        manifests.push(...scanDirectory(dir));
    }
    return deduplicate(manifests);
}
```

### 4.2 Manifest Discovery

```typescript
function scanDirectory(dir: string): PluginManifest[] {
    if (!existsSync(dir)) return [];
    const manifests: PluginManifest[] = [];

    for (const pkg of readdirSync(dir)) {
        const packageJson = join(dir, pkg, "package.json");
        if (!existsSync(packageJson)) continue;

        const json = JSON.parse(readFileSync(packageJson, "utf-8"));
        if (!json.myapp || !json.myapp.entryPoint) continue;

        manifests.push({
            name: json.name,
            version: json.version,
            description: json.description,
            entryPoint: json.myapp.entryPoint,
            slots: json.myapp.slots || [],
            dependencies: json.dependencies,
            config: json.myapp.config,
        });
    }
    return manifests;
}
```

### 4.3 Package.json Conventions

```json
{
    "name": "@skwid138/my-plugin",
    "version": "1.0.0",
    "description": "My cool plugin",
    "myapp": {
        "entryPoint": "./dist/plugin.js",
        "slots": ["home_logo", "home_prompt"],
        "config": {
            "color": "#FFB000",
            "animation": true
        }
    },
    "dependencies": {
        "@myapp/core": "^1.0.0"
    }
}
```

---

## 5. Module Resolution

### 5.1 Custom Resolver (Not npm's)

The plugin loader uses its own module resolver rather than Node.js's default `require()`:

```typescript
class PluginModuleResolver {
    private cache: Map<string, any> = new Map();
    private pluginRoots: Map<string, string> = new Map();

    resolve(pluginDir: string, importPath: string): any {
        const cacheKey = `${pluginDir}:${importPath}`;
        if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

        // 1. Relative import (./ or ../)
        if (importPath.startsWith(".")) {
            const absolute = resolveRelative(pluginDir, importPath);
            return this.loadModule(absolute);
        }

        // 2. Plugin-scoped dependency
        const pluginNodeModules = join(pluginDir, "node_modules");
        const scoped = resolveFrom(pluginNodeModules, importPath);
        if (scoped) return this.loadModule(scoped);

        // 3. App-core dependency (provided by host)
        if (this.hostModules.has(importPath)) {
            return this.hostModules.get(importPath);
        }

        // 4. Global node_modules fallback
        const global = resolveGlobal(importPath);
        if (global) return this.loadModule(global);

        throw new ModuleNotFoundError(importPath);
    }

    private loadModule(absolutePath: string): any {
        if (this.cache.has(absolutePath)) return this.cache.get(absolutePath);

        // Use dynamic import() for ESM support, fall back to require() for CJS
        const mod = loadModuleAt(absolutePath);
        this.cache.set(absolutePath, mod);
        return mod;
    }
}
```

### 5.2 The Cache Override

Critical detail: the cache location takes priority over node_modules:

```typescript
function resolvePluginCopy(pluginName: string): string {
    const cacheDir = join(homeDir, ".cache", "myapp", "packages");
    const cachePath = join(cacheDir, pluginName, "node_modules", pluginName);

    if (existsSync(cachePath)) return cachePath;

    // Fall back to user-installed
    const userPath = join(homeDir, ".myapp", "node_modules", pluginName);
    if (existsSync(userPath)) return userPath;

    // Fall back to global
    return resolveGlobalNodeModules(pluginName);
}
```

---

## 6. Plugin Sandbox

Each plugin receives a limited API object. It does NOT get access to `require()`, `process`, or the full filesystem.

```typescript
function createPluginAPI(plugin: PluginInstance): PluginAPI {
    return Object.freeze({
        slots: {
            register: (def: SlotDefinition) => {
                validateSlot(def);
                slotRegistry.add(def);
            },
            unregister: (id: string) => slotRegistry.remove(id),
            get: (name: string) => slotRegistry.get(name),
        },

        config: {
            get: (key: string) => pluginConfig.get(plugin.id, key),
            set: (key: string, value: any) => pluginConfig.set(plugin.id, key, value),
        },

        logger: {
            info: (msg: string) => log(`[${plugin.id}] ${msg}`),
            warn: (msg: string) => log(`[${plugin.id}] WARN: ${msg}`),
            error: (msg: string) => log(`[${plugin.id}] ERROR: ${msg}`),
        },

        events: {
            on: (event: string, cb: Function) => eventBus.on(event, cb),
            emit: (event: string, data: any) => eventBus.emit(event, data),
        },

        fs: createFsSandbox(plugin.directory),
        http: createHttpSandbox(),  // read-only, time-limited
    });
}

function createFsSandbox(baseDir: string): FsAccess {
    return {
        readFile: (path: string) => {
            const resolved = resolveSafe(baseDir, path);
            if (!resolved.startsWith(baseDir)) {
                throw new SandboxViolation("Filesystem access denied");
            }
            return readFile(resolved, "utf-8");
        },
        exists: (path: string) => existsSync(resolveSafe(baseDir, path)),
        // No write access unless explicitly granted
    };
}
```

---

## 7. Loading & Lifecycle

```typescript
class PluginManager {
    private plugins: Map<string, PluginInstance> = new Map();
    private resolver: PluginModuleResolver;

    async loadPlugins(): Promise<void> {
        const manifests = findPlugins();

        for (const manifest of manifests) {
            await this.loadPlugin(manifest);
        }
    }

    async loadPlugin(manifest: PluginManifest): Promise<PluginInstance> {
        const pluginDir = findPluginDirectory(manifest.name);
        const entryPath = join(pluginDir, manifest.entryPoint);

        try {
            const module = await this.resolver.resolve(pluginDir, entryPath);

            const instance: PluginInstance = {
                id: manifest.name,
                manifest,
                directory: pluginDir,
                module,
                api: createPluginAPI(this),
                state: "loaded",
            };

            // Call the plugin's init function (if it has one)
            if (typeof module.default === "function") {
                module.default(instance.api);
            } else if (typeof module.init === "function") {
                module.init(instance.api);
            }

            instance.state = "active";
            this.plugins.set(instance.id, instance);
            return instance;

        } catch (err) {
            return {
                id: manifest.name,
                manifest,
                directory: pluginDir,
                module: null,
                api: null,
                state: "error",
                error: err as Error,
            };
        }
    }

    unloadPlugin(id: string): void {
        const plugin = this.plugins.get(id);
        if (!plugin) return;

        // 1. Unregister all slots
        plugin.api?.slots.unregister(plugin.id);

        // 2. Clean up event listeners
        plugin.api?.events.removeAll(plugin.id);

        // 3. Clear module from cache
        this.resolver.evict(plugin.id);

        this.plugins.delete(id);
    }

    async reloadPlugin(id: string): Promise<void> {
        this.unloadPlugin(id);
        const manifest = findPluginManifest(id);
        if (manifest) await this.loadPlugin(manifest);
    }
}
```

---

## 8. The Slot System

Slots are named extension points in the application. Plugins register render functions into slots.

### 8.1 Slot Registration

```typescript
interface SlotRegistry {
    // Plugin side:
    register(def: {
        slot: string;       // e.g. "home_logo"
        id: string;         // unique id for this registration
        component: ComponentFactory;
        priority?: number;  // lower = rendered first
    }): void;

    // Application side:
    getComponents(slot: string): ComponentFactory[];
}
```

### 8.2 Available Slots

```typescript
const BUILT_IN_SLOTS = {
    // Layout-level
    "app:header":       "Top bar area",
    "app:footer":       "Status bar area",
    "app:sidebar":      "Left sidebar",

    // Home screen
    "home:logo":        "Logo/branding area",
    "home:greeting":    "Greeting text",
    "home:cursor":      "Input cursor",
    "home:prompt":      "Prompt hint text",

    // Input
    "input:before":     "Before input (prefix)",
    "input:after":      "After input (suffix)",
    "input:suggestions":"Suggestion dropdown area",

    // Content panels
    "panel:header":     "Panel title bar",
    "panel:content":    "Panel body",
    "panel:footer":     "Panel actions",

    // Events
    "event:init":       "App initialized",
    "event:render":     "Frame rendered",
    "event:key":        "Key pressed",
};
```

### 8.3 Slot Rendering

```typescript
function renderSlot(slotName: string): ComponentNode[] {
    const defs = slotRegistry.getComponents(slotName)
        .sort((a, b) => (a.priority || 0) - (b.priority || 0));

    return defs.map(def => {
        try {
            return def.component(api, props);
        } catch (err) {
            return createErrorComponent(err);
        }
    });
}
```

---

## 9. Hot Reloading

```typescript
class HotReloader {
    private watcher: FsWatcher;
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

    start(pluginManager: PluginManager): void {
        this.watcher = watch(pluginDirectories, { recursive: true });

        this.watcher.on("change", (filePath: string) => {
            const pluginId = this.getPluginIdForFile(filePath);
            if (!pluginId) return;

            // Debounce: wait 300ms after last change
            clearTimeout(this.debounceTimers.get(pluginId));
            this.debounceTimers.set(pluginId, setTimeout(() => {
                console.log(`[hot-reload] Reloading ${pluginId}...`);
                pluginManager.reloadPlugin(pluginId);
            }, 300));
        });
    }

    stop(): void {
        this.watcher?.close();
    }
}
```

---

## 10. Distribution

### 10.1 Plugin Package Format

```
my-plugin/
  package.json        # manifest
  dist/
    plugin.js         # compiled entry point
    styles.css        # (optional)
  assets/
    logo.png          # (optional)
  README.md
```

### 10.2 Install Command

```
myapp plugin install author/plugin-name
myapp plugin install @skwid138/opencode-tui
```

### 10.3 Cache Update

```
1. Download plugin tarball from registry
2. Extract to ~/.cache/myapp/packages/author/plugin-name/
3. Run npm install inside plugin dir (resolve its deps)
4. Verify entry point exists
5. Signal hot-reloader
```

---

## 11. Key Decisions

| Decision | Rationale |
|----------|-----------|
| Custom module resolver | Control over resolution order and sandboxing |
| Cache overrides node_modules | Deterministic loading, avoids npm global state |
| Sandboxed API | Plugins cannot access process, raw require, or full filesystem |
| Slots not events | Slots are for rendering; events are for signalling |
| Hot reload via file watcher | Fast iteration during plugin development |
| Dynamic import() for ESM | Supports modern JS module format |

---

## 12. Files

```
src/
  plugins/
    manager.ts        -- PluginManager class
    discovery.ts      -- findPlugins, scan directories
    resolver.ts       -- custom module resolver
    sandbox.ts        -- createPluginAPI, sandbox wrappers
    slot.ts           -- SlotRegistry
    manifest.ts       -- Manifest parsing, validation
    hotreload.ts      -- file watcher, debounce, reload
    types.ts          -- shared types
  slots/
    builtin.ts        -- list of built-in slot names
```

---

## 13. Security Considerations

| Threat | Mitigation |
|--------|------------|
| Malicious plugin reads arbitrary files | FsSandbox restricts to plugin directory |
| Plugin accesses network | HttpSandbox allows only read-only GET (no POST) |
| Plugin crashes main process | Run plugin init in a VM context or try-catch |
| Plugin consumes too much CPU | Track execution time, terminate long-running loops |
| Plugin depends on vulnerable library | Scan dependencies on install, warn user |
