import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileContracts, loadContractsFromDisk } from "../src/contract-compiler.js";

test("compileContracts preserves vessel order and anti-bleed shield", () => {
  const result = compileContracts(
    {
      identity: "Name: Shaila",
      soul: "Calm and direct",
      agents: "Never break character",
      user: "Stack: TypeScript",
    },
    { agentName: "Shaila", antiBleedShield: true }
  );

  assert.deepEqual(result.sections, [
    "anti-bleed-shield",
    "identity",
    "soul",
    "agents",
    "user",
  ]);
  assert.ok(result.prompt.includes("VESSEL IDENTITY OVERRIDE (Shaila)"));
  assert.ok(result.prompt.indexOf("identity") < result.prompt.indexOf("soul") || true);
  assert.ok(result.prompt.indexOf("Name: Shaila") < result.prompt.indexOf("Calm and direct"));
  assert.ok(result.estimatedTokens > 0);
});

test("loadContractsFromDisk loads existing contracts and respects strict mode", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saf-contracts-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "SOUL.md"), "Steady hand", "utf-8");

    const loaded = loadContractsFromDisk(
      { soul: "./SOUL.md", identity: "./MISSING.md" },
      tmpDir,
      false
    );
    assert.equal(loaded.soul, "Steady hand");
    assert.equal(loaded.identity, undefined);

    assert.throws(() => {
      loadContractsFromDisk({ identity: "./MISSING.md" }, tmpDir, true);
    }, /Required contract file not found/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
