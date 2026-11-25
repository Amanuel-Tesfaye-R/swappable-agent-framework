import fs from "node:fs";
import { PowerSourceRouter } from "../dist/src/index.js";

const config = JSON.parse(
  fs.readFileSync(new URL("./config/agent.config.json", import.meta.url), "utf-8")
);

const router = new PowerSourceRouter(config, {
  baseDir: new URL("./config/", import.meta.url).pathname,
  contracts: {
    identity: "You are Shaila, persistent engineering co-pilot.",
    soul: "Direct, calm, concise. Zero filler.",
  },
});

console.log("Active provider:", router.getActiveProvider());
console.log("Registered power sources:", router.listProviders());

// Hot-swap mid-session without touching identity or history
router.swapProvider("google", undefined, "Switching to Gemini for fast context sweep");
console.log("After swap:", router.getActiveProvider());
console.log("\nCompiled System Prompt Preview:\n");
console.log(router.compileSystemPrompt());
