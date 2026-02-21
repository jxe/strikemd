export interface BlockSplit {
  frontmatter: string;
  blocks: string[];
}

export interface ReconstructResult {
  annotated: string;
  warnings: string[];
}

/**
 * Strip annotation tags, recovering original text.
 * <del ...>text</del> → text (keep del content)
 * <ins ...>text</ins> → "" (remove insertions)
 */
function stripAnnotations(text: string): string {
  return text
    .replace(/<del\s+comment="[^"]*"(?:\s+replaceWith="[^"]*")?>([\s\S]*?)<\/del>/g, '$1')
    .replace(/<ins\s+comment="[^"]*">([\s\S]*?)<\/ins>/g, '');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Merge adjacent <del>+<ins> or <ins>+<del> pairs into a single <del replaceWith="">.
 * The model sometimes outputs two tags instead of using replaceWith.
 */
function mergeAdjacentAnnotations(text: string): string {
  // <del>...</del> immediately followed by <ins>...</ins>
  text = text.replace(
    /<del\s+comment="([^"]*)">([\s\S]*?)<\/del>\s*<ins\s+comment="[^"]*">([\s\S]*?)<\/ins>/g,
    (_m, comment, delContent, insContent) =>
      `<del comment="${comment}" replaceWith="${escapeAttr(insContent)}">${delContent}</del>`
  );
  // <ins>...</ins> immediately followed by <del>...</del>
  text = text.replace(
    /<ins\s+comment="[^"]*">([\s\S]*?)<\/ins>\s*<del\s+comment="([^"]*)">([\s\S]*?)<\/del>/g,
    (_m, insContent, comment, delContent) =>
      `<del comment="${comment}" replaceWith="${escapeAttr(insContent)}">${delContent}</del>`
  );
  return text;
}

/**
 * Split markdown into frontmatter + paragraph-level blocks.
 * Code-fence-aware: blank lines inside fenced code don't cause splits.
 */
export function splitIntoBlocks(markdown: string): BlockSplit {
  let frontmatter = "";
  let body = markdown;

  const fmMatch = markdown.match(/^(---\n[\s\S]*?\n---\n)/);
  if (fmMatch) {
    frontmatter = fmMatch[1];
    body = markdown.slice(fmMatch[1].length);
  }

  const blocks: string[] = [];
  let current = "";
  let inFence = false;
  let blankRun = false;

  for (const line of body.split("\n")) {
    if (/^```/.test(line)) {
      inFence = !inFence;
    }

    if (!inFence && line.trim() === "") {
      if (current.trim() !== "") {
        blankRun = true;
      }
      continue;
    }

    // Non-blank line
    if (blankRun && current.trim() !== "") {
      blocks.push(current.trimEnd());
      current = line;
      blankRun = false;
    } else {
      if (current) current += "\n";
      current += line;
    }
  }

  if (current.trim()) {
    blocks.push(current.trimEnd());
  }

  return { frontmatter, blocks };
}

/**
 * Format blocks as numbered input for the model.
 */
export function formatBlocksForModel(blocks: string[]): string {
  return blocks.map((block, i) => `[${i + 1}] ${block}`).join("\n\n");
}

/**
 * Parse the model's output into a map of block number → content.
 * Each line is: "N lgtm" or "N <full block with annotations>"
 * Multi-line blocks are handled by continuing until the next numbered line.
 */
export function parseModelOutput(output: string): Map<number, string> {
  const result = new Map<number, string>();
  const lines = output.split("\n");

  let currentNum: number | null = null;
  let currentContent = "";

  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)/);
    if (match) {
      // Save previous block if any
      if (currentNum !== null) {
        result.set(currentNum, currentContent.trim());
      }
      currentNum = parseInt(match[1], 10);
      currentContent = match[2];
    } else if (currentNum !== null && line.trim() !== "") {
      // Continuation of current block
      currentContent += "\n" + line;
    }
  }

  // Save last block
  if (currentNum !== null) {
    result.set(currentNum, currentContent.trim());
  }

  return result;
}

/**
 * Reconstruct the full annotated document from model output + original blocks.
 * The model outputs entire blocks with <del>/<ins> annotations inline,
 * so reconstruction is just using the model's output directly.
 */
export function reconstruct(
  parsedOutput: Map<number, string>,
  frontmatter: string,
  originalBlocks: string[]
): ReconstructResult {
  const warnings: string[] = [];
  const resultBlocks: string[] = [];

  for (let i = 0; i < originalBlocks.length; i++) {
    const blockNum = i + 1;
    const modelContent = parsedOutput.get(blockNum);

    if (modelContent === undefined) {
      warnings.push(`Block ${blockNum} missing from model output; using original`);
      resultBlocks.push(originalBlocks[i]);
    } else if (modelContent === "lgtm") {
      resultBlocks.push(originalBlocks[i]);
    } else {
      // Model output IS the annotated block — use it directly
      // Merge adjacent <del>+<ins> pairs the model should have written as replaceWith
      const merged = mergeAdjacentAnnotations(modelContent);
      // Verify: stripping annotations should recover the original
      const stripped = stripAnnotations(merged);
      if (stripped !== originalBlocks[i]) {
        warnings.push(`Block ${blockNum}: model modified text outside annotations`);
      }
      resultBlocks.push(merged);
    }
  }

  const annotated = frontmatter + resultBlocks.join("\n\n");
  return { annotated, warnings };
}
