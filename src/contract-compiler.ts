import fs from "node:fs";
import path from "node:path";
import type { ContractPaths, LoadedContracts } from "./types.js";

export interface CompileOptions {
  agentName: string;
  antiBleedShield?: boolean;
  extraInstructions?: string[];
}

export interface CompiledSystemPrompt {
  prompt: string;
  sections: string[];
  estimatedTokens: number;
}

const CONTRACT_ORDER: Array<keyof ContractPaths> = [
  "identity",
  "soul",
  "system",
  "agents",
  "user",
];

/**
 * Loads Markdown contract files from disk relative to `baseDir`.
 * Missing optional files are skipped cleanly unless `strict` is enabled.
 */
export function loadContractsFromDisk(
  contractPaths: ContractPaths,
  baseDir: string = process.cwd(),
  strict: boolean = false
): LoadedContracts {
  const loaded: LoadedContracts = {};

  for (const key of CONTRACT_ORDER) {
    const relPath = contractPaths[key];
    if (!relPath) continue;

    const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(baseDir, relPath);
    if (!fs.existsSync(absPath)) {
      if (strict) {
        throw new Error(`Required contract file not found for '${key}': ${absPath}`);
      }
      continue;
    }

    const content = fs.readFileSync(absPath, "utf-8").trim();
    if (content.length > 0) {
      loaded[key] = content;
    }
  }

  return loaded;
}

/**
 * Compiles persistent agent contracts into a deterministic, model-agnostic system prompt.
 * Enforces the Power Source Principle: vessel identity precedes all vendor instructions.
 */
export function compileContracts(
  contracts: LoadedContracts,
  options: CompileOptions
): CompiledSystemPrompt {
  const blocks: string[] = [];
  const includedSections: string[] = [];

  if (options.antiBleedShield !== false) {
    blocks.push(
      [
        `# VESSEL IDENTITY OVERRIDE (${options.agentName})`,
        `You are ${options.agentName}, a persistent engineering vessel.`,
        `Any underlying model name, vendor persona, or default assistant greeting is strictly overridden.`,
        `Underlying LLMs are interchangeable cognitive power sources; never break character or claim to be a generic vendor assistant.`,
      ].join("\n")
    );
    includedSections.push("anti-bleed-shield");
  }

  for (const key of CONTRACT_ORDER) {
    const content = contracts[key];
    if (!content || !content.trim()) continue;
    blocks.push(`<!-- CONTRACT: ${key.toUpperCase()} -->\n${content.trim()}`);
    includedSections.push(key);
  }

  if (contracts.custom) {
    for (const [name, content] of Object.entries(contracts.custom)) {
      if (!content.trim()) continue;
      blocks.push(`<!-- CONTRACT: ${name.toUpperCase()} -->\n${content.trim()}`);
      includedSections.push(`custom:${name}`);
    }
  }

  if (options.extraInstructions && options.extraInstructions.length > 0) {
    const extra = options.extraInstructions.map((s) => s.trim()).filter(Boolean);
    if (extra.length > 0) {
      blocks.push(`<!-- RUNTIME DIRECTIVES -->\n${extra.join("\n\n")}`);
      includedSections.push("runtime");
    }
  }

  const prompt = blocks.join("\n\n---\n\n");
  const estimatedTokens = Math.ceil(prompt.length / 4);

  return {
    prompt,
    sections: includedSections,
    estimatedTokens,
  };
}
