#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { compileContracts, loadContractsFromDisk } from "./contract-compiler.js";
import { PowerSourceRouter } from "./router.js";
import { SessionStore } from "./session-store.js";
import type { AgentConfig } from "./types.js";

function loadConfig(configPath: string): { config: AgentConfig; baseDir: string } {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}. Run 'saf init' to generate one.`);
  }
  const config = JSON.parse(fs.readFileSync(abs, "utf-8")) as AgentConfig;
  return { config, baseDir: path.dirname(abs) };
}

function cmdInit(targetDir: string): void {
  const dir = path.resolve(targetDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const specsDir = path.join(dir, "contracts");
  if (!fs.existsSync(specsDir)) fs.mkdirSync(specsDir, { recursive: true });

  const defaultConfig: AgentConfig = {
    agent: {
      name: "CoPilot",
      version: "1.0.0",
      activeProvider: "anthropic",
      fallbackOrder: ["google", "openai", "ollama"],
      antiBleedShield: true,
      contracts: {
        identity: "./contracts/IDENTITY.md",
        soul: "./contracts/SOUL.md",
        agents: "./contracts/AGENTS.md",
      },
      providers: {
        anthropic: {
          kind: "anthropic",
          model: "claude-3-5-sonnet-20241022",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          temperature: 0.2,
          maxTokens: 8192,
        },
        google: {
          kind: "google",
          model: "gemini-2.0-flash",
          apiKeyEnv: "GEMINI_API_KEY",
          temperature: 0.2,
          maxTokens: 8192,
        },
        openai: {
          kind: "openai",
          model: "gpt-4o",
          apiKeyEnv: "OPENAI_API_KEY",
          temperature: 0.2,
          maxTokens: 4096,
        },
        ollama: {
          kind: "ollama",
          model: "qwen2.5-coder:32b",
          baseURL: "http://localhost:11434",
        },
      },
    },
  };

  const configPath = path.join(dir, "agent.config.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
  }

  const starterContracts: Record<string, string> = {
    "IDENTITY.md": "# Identity\nName: CoPilot\nRole: Persistent engineering partner.\n",
    "SOUL.md": "# Soul\nCalm, concise, zero corporate filler. Direct engineering execution.\n",
    "AGENTS.md": "# Directives\nMaintain persistent identity regardless of active LLM provider.\n",
  };

  for (const [file, content] of Object.entries(starterContracts)) {
    const p = path.join(specsDir, file);
    if (!fs.existsSync(p)) fs.writeFileSync(p, content, "utf-8");
  }

  console.log(`Initialized Swappable Agent workspace in ${dir}`);
}

function cmdCompile(configPath: string): void {
  const { config, baseDir } = loadConfig(configPath);
  const loaded = config.agent.contracts
    ? loadContractsFromDisk(config.agent.contracts, baseDir)
    : {};
  const compiled = compileContracts(loaded, {
    agentName: config.agent.name,
    antiBleedShield: config.agent.antiBleedShield ?? true,
  });

  console.log(`Agent: ${config.agent.name}`);
  console.log(`Sections: ${compiled.sections.join(", ")}`);
  console.log(`Estimated Tokens: ${compiled.estimatedTokens}\n`);
  console.log(compiled.prompt);
}

function cmdProviders(configPath: string): void {
  const { config, baseDir } = loadConfig(configPath);
  const router = new PowerSourceRouter(config, { baseDir });
  for (const p of router.listProviders()) {
    const marker = p.active ? "* " : "  ";
    console.log(`${marker}${p.id} (${p.kind} -> ${p.model})`);
  }
}

function cmdSwap(configPath: string, targetProvider: string): void {
  const abs = path.resolve(configPath);
  const { config } = loadConfig(abs);
  if (!config.agent.providers[targetProvider]) {
    throw new Error(`Provider '${targetProvider}' is not defined in ${abs}.`);
  }
  const previous = config.agent.activeProvider;
  config.agent.activeProvider = targetProvider;
  fs.writeFileSync(abs, JSON.stringify(config, null, 2), "utf-8");
  console.log(`Swapped power source: ${previous} -> ${targetProvider}`);
}

async function cmdAsk(configPath: string, prompt: string, sessionId: string): Promise<void> {
  const { config, baseDir } = loadConfig(configPath);
  const store = new SessionStore(path.join(baseDir, ".saf-sessions"));
  const router = new PowerSourceRouter(config, { baseDir, sessionStore: store });

  const response = await router.chat(sessionId, prompt);
  console.log(`[${response.provider}:${response.model}]`);
  console.log(response.content);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const configFlagIdx = args.indexOf("--config");
  const configPath =
    configFlagIdx !== -1 && args[configFlagIdx + 1]
      ? args[configFlagIdx + 1]
      : "./agent.config.json";

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        "saf - Swappable Agent Framework CLI",
        "",
        "Commands:",
        "  saf init [dir]                  Scaffold agent.config.json and starter contracts",
        "  saf compile [--config path]     Compile contracts and show token estimate",
        "  saf providers [--config path]   List configured cognitive power sources",
        "  saf swap <id> [--config path]   Hot-swap the active provider in config",
        "  saf ask <prompt> [--session id] Send a prompt via the active power source",
      ].join("\n")
    );
    return;
  }

  switch (cmd) {
    case "init":
      cmdInit(args[1] || ".");
      break;
    case "compile":
      cmdCompile(configPath);
      break;
    case "providers":
      cmdProviders(configPath);
      break;
    case "swap":
      if (!args[1]) throw new Error("Usage: saf swap <provider-id>");
      cmdSwap(configPath, args[1]);
      break;
    case "ask": {
      const sessionIdx = args.indexOf("--session");
      const sessionId = sessionIdx !== -1 && args[sessionIdx + 1] ? args[sessionIdx + 1] : "default";
      const prompt = args[1];
      if (!prompt) throw new Error("Usage: saf ask \"<prompt>\"");
      await cmdAsk(configPath, prompt, sessionId);
      break;
    }
    default:
      throw new Error(`Unknown command '${cmd}'. Run 'saf --help' for usage.`);
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
