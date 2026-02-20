import { existsSync } from "fs";
import { join } from "path";

export interface Check {
  name: string;
  prompt: string;
}

function parseChecksMarkdown(content: string): Record<string, Check> {
  const checks: Record<string, Check> = {};
  const sections = content.split(/^# /m).filter(Boolean);

  for (const section of sections) {
    const newlineIdx = section.indexOf("\n");
    if (newlineIdx === -1) continue;
    const name = section.slice(0, newlineIdx).trim();
    const prompt = section.slice(newlineIdx + 1).trim();
    if (name && prompt) {
      checks[name] = { name, prompt };
    }
  }

  return checks;
}

export async function loadChecks(projectRoot: string): Promise<Record<string, Check>> {
  // If user has .strikemd/checks.md, use it exclusively (overrides built-ins)
  const userPath = join(projectRoot, ".strikemd", "checks.md");
  if (existsSync(userPath)) {
    const userContent = await Bun.file(userPath).text();
    const checks = parseChecksMarkdown(userContent);
    console.log(`Checks: .strikemd/checks.md (${Object.keys(checks).length})`);
    return checks;
  }

  // Otherwise fall back to built-in defaults
  const defaultsPath = join(import.meta.dir, "..", "checks", "defaults.md");
  const defaultsContent = await Bun.file(defaultsPath).text();
  const checks = parseChecksMarkdown(defaultsContent);
  console.log(`Checks: built-in defaults (${Object.keys(checks).length})`);
  return checks;
}

export function listChecks(checks: Record<string, Check>): void {
  console.log("\nAvailable checks:\n");
  for (const name of Object.keys(checks)) {
    console.log(`  ${name}`);
  }
  console.log("");
}
