// Matches <strike> with <del>/<ins> in either order (same as parse.ts)
const STRIKE_RE =
  /<strike\s+comment="([^"]*)">\s*(?:(?:<del>([\s\S]*?)<\/del>)\s*(?:<ins>([\s\S]*?)<\/ins>)?|(?:<ins>([\s\S]*?)<\/ins>)\s*(?:<del>([\s\S]*?)<\/del>)?)\s*<\/strike>/g;

export interface BlockSplit {
  frontmatter: string;
  blocks: string[];
}

export interface ReconstructResult {
  annotated: string;
  warnings: string[];
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
 * Parse the model's compact output into a map of block number → content.
 * Each line is: "N lgtm" or "N <strike ...>...</strike>"
 * Multi-line blocks (e.g. code fences with changes) are handled by
 * continuing until the next numbered line.
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
 * Splice a single <strike> annotation into the original block text.
 * For replacements/deletions: find <del> text in original and replace with full tag.
 * For insertions: use the text before <strike> as an anchor.
 */
function spliceAnnotation(original: string, annotation: string): { result: string; warning: string | null } {
  // Extract del content to use as anchor
  const delMatch = annotation.match(/<del>([\s\S]*?)<\/del>/);

  if (delMatch) {
    // Replacement or deletion: find <del> text in original
    const delText = delMatch[1];
    const idx = original.indexOf(delText);
    if (idx === -1) {
      return { result: original, warning: `Could not find <del> text in block: "${delText.slice(0, 50)}"` };
    }
    const result = original.slice(0, idx) + annotation + original.slice(idx + delText.length);
    return { result, warning: null };
  }

  // Insertion only: look for anchor text before the <strike> tag
  const strikeIdx = annotation.indexOf("<strike");
  if (strikeIdx > 0) {
    const anchor = annotation.slice(0, strikeIdx).trimEnd();
    const anchorIdx = original.indexOf(anchor);
    if (anchorIdx !== -1) {
      const insertPoint = anchorIdx + anchor.length;
      const strikeTag = annotation.slice(strikeIdx);
      const result = original.slice(0, insertPoint) + " " + strikeTag + original.slice(insertPoint);
      return { result, warning: null };
    }
    return { result: original, warning: `Could not find insertion anchor in block: "${anchor.slice(0, 50)}"` };
  }

  // Insertion with no anchor: append to end of block
  return { result: original + " " + annotation, warning: "Insertion with no anchor, appended to block" };
}

/**
 * Reconstruct the full annotated document from model output + original blocks.
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
      // Contains annotation(s) — splice each <strike> tag into the original
      let block = originalBlocks[i];
      const re = new RegExp(STRIKE_RE.source, STRIKE_RE.flags);

      // Extract all annotations from the model's line, preserving any
      // text before each one (anchors for insertions)
      const annotations: string[] = [];
      let lastEnd = 0;
      let match: RegExpExecArray | null;

      while ((match = re.exec(modelContent)) !== null) {
        // Include any prefix text (anchor for insertions)
        const prefix = modelContent.slice(lastEnd, match.index).trim();
        const fullAnnotation = prefix ? prefix + " " + match[0] : match[0];
        annotations.push(fullAnnotation);
        lastEnd = match.index + match[0].length;
      }

      if (annotations.length === 0) {
        warnings.push(`Block ${blockNum}: model output has no annotations and isn't 'lgtm'`);
        resultBlocks.push(originalBlocks[i]);
        continue;
      }

      for (const annotation of annotations) {
        const { result, warning } = spliceAnnotation(block, annotation);
        block = result;
        if (warning) warnings.push(`Block ${blockNum}: ${warning}`);
      }

      resultBlocks.push(block);
    }
  }

  const annotated = frontmatter + resultBlocks.join("\n\n");
  return { annotated, warnings };
}
