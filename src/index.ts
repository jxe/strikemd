#!/usr/bin/env bun

import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { loadChecks, listChecks } from "./checks";
import { startServer } from "./server";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: strikemd <file.md> [--key <api-key>]");
    console.log("       strikemd --list");
    console.log("");
    console.log("Options:");
    console.log("  --key <key>  Anthropic API key (or set ANTHROPIC_API_KEY env var / .env)");
    console.log("  --list       List available checks");
    process.exit(0);
  }

  // Extract --key flag
  let cliApiKey: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key" && i + 1 < args.length) {
      cliApiKey = args[i + 1];
      i++; // skip the value
    } else {
      filteredArgs.push(args[i]);
    }
  }

  // Find project root (walk up looking for .strikemd/ or .git/)
  const cwd = process.cwd();
  let projectRoot = cwd;
  let dir = cwd;
  while (dir !== "/") {
    if (existsSync(resolve(dir, ".strikemd")) || existsSync(resolve(dir, ".git"))) {
      projectRoot = dir;
      break;
    }
    dir = dirname(dir);
  }

  // Handle --list
  if (filteredArgs[0] === "--list") {
    const checks = await loadChecks(projectRoot);
    listChecks(checks);
    process.exit(0);
  }

  // Parse file argument
  const filePath = resolve(filteredArgs[0]);
  if (!existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  // Load API key: --key flag > env var > .env files
  let apiKey = cliApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const envPaths = [
      resolve(projectRoot, ".env"),
      resolve(import.meta.dir, "..", ".env"),
    ];
    for (const envPath of envPaths) {
      if (existsSync(envPath)) {
        const content = await Bun.file(envPath).text();
        const match = content.match(/ANTHROPIC_API_KEY=(.+)/);
        if (match) {
          apiKey = match[1].trim();
          break;
        }
      }
    }
  }

  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY not found. Pass --key, set env var, or add to .env");
    process.exit(1);
  }

  // Start server
  const { url } = startServer({ filePath, projectRoot, apiKey });
  console.log(`\nstrikemd → ${url}`);
  console.log(`Editing: ${filePath}\n`);

  // Open browser
  Bun.spawn(["open", url]);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
