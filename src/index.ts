#!/usr/bin/env bun

import { resolve, dirname, join } from "path";
import { existsSync, mkdirSync } from "fs";
import { loadChecks, listChecks } from "./checks";
import { startServer } from "./server";

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    console.log(pkg.version);
    process.exit(0);
  }

  if (args.length === 0 || args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: strikemd <file.md> [--key <api-key>]");
    console.log("       strikemd init");
    console.log("       strikemd list");
    console.log("");
    console.log("Commands:");
    console.log("  init         Create .strikemd/checks.md with default checks");
    console.log("  list         List available checks");
    console.log("");
    console.log("Options:");
    console.log("  --key <key>  Anthropic API key (or set ANTHROPIC_API_KEY env var / .env)");
    process.exit(0);
  }

  // Subcommands (before project root discovery — init creates .strikemd/)
  if (args[0] === "init") {
    const dest = resolve(process.cwd(), ".strikemd");
    const checksPath = join(dest, "checks.md");
    if (existsSync(checksPath)) {
      console.error("Already initialized: .strikemd/checks.md exists");
      process.exit(1);
    }
    const defaultsPath = join(import.meta.dir, "..", "checks", "defaults.md");
    const defaults = await Bun.file(defaultsPath).text();
    mkdirSync(dest, { recursive: true });
    await Bun.write(checksPath, defaults);
    console.log("Created .strikemd/checks.md — edit this file to customize your checks.");
    process.exit(0);
  }

  if (args[0] === "list") {
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
    const checks = await loadChecks(projectRoot);
    listChecks(checks);
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
          apiKey = match[1].trim().replace(/^["']|["']$/g, "");
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
