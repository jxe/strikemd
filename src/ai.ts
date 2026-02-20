import Anthropic from "@anthropic-ai/sdk";
import type { Check } from "./checks";
import { validate } from "./parse";
import {
  splitIntoBlocks,
  formatBlocksForModel,
  parseModelOutput,
  reconstruct,
} from "./reconstruct";

const ANNOTATION_INSTRUCTIONS = `
RESPONSE FORMAT — you must follow these rules exactly:

The document has been divided into numbered blocks. You will see each block prefixed with [N].

You must respond with one line per block, in order. For each block:

If the block needs NO changes, write:
N lgtm

If the block needs changes, write ONLY the annotation(s) — do NOT repeat the surrounding text:
N <strike comment="explanation"><del>old text</del><ins>new text</ins></strike>

Annotation types:
- Replacement: <strike comment="why"><del>old text</del><ins>new text</ins></strike>
- Deletion: <strike comment="why"><del>text to remove</del></strike>
- Insertion: anchor text <strike comment="why"><ins>new text</ins></strike>
  (include ~5 words before the <strike> tag so we can locate the insertion point)

If a block has multiple changes, put all annotations on the same line separated by spaces.

RULES:
- You MUST include a line for every numbered block. Do not skip any.
- Do NOT include any preamble, commentary, or explanation. Just the numbered lines.
- The comment attribute should briefly explain WHY (1-2 sentences).
- The <del> text must exactly match the original text in the block.
- Content inside <del> and <ins> is raw markdown, not HTML-escaped.
- Do NOT use double quotes inside the comment attribute — use single quotes instead.
- Preserve all LaTeX math, footnotes, citations, and formatting exactly.
- Make targeted changes. Do not rewrite passages unnecessarily.`;

const DEFAULT_MODEL = "claude-sonnet-4-6";
const THINKING_BUDGET = 10000;

export async function runAnnotation(
  markdown: string,
  check: Check,
  apiKey: string,
  model: string = DEFAULT_MODEL
): Promise<string> {
  const client = new Anthropic({ apiKey });

  // Split document into blocks
  const { frontmatter, blocks } = splitIntoBlocks(markdown);
  const numberedInput = formatBlocksForModel(blocks);

  console.log(`  ${blocks.length} blocks`);

  const systemPrompt = `${check.prompt}\n${ANNOTATION_INSTRUCTIONS}`;

  const message = await client.messages.create({
    model,
    max_tokens: 16384,
    thinking: {
      type: "enabled",
      budget_tokens: THINKING_BUDGET,
    },
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Here is the document to review:\n\n${numberedInput}`,
      },
    ],
  });

  // Extract the text response (skip thinking blocks)
  let responseText = "";
  for (const block of message.content) {
    if (block.type === "text") {
      responseText = block.text;
      break;
    }
  }

  if (!responseText) {
    throw new Error("No text response from model");
  }

  // Parse and reconstruct
  const parsed = parseModelOutput(responseText);
  const { annotated, warnings } = reconstruct(parsed, frontmatter, blocks);

  for (const w of warnings) {
    console.warn("  ⚠", w);
  }

  // Validate the reconstructed document
  const errors = validate(annotated);
  if (errors.length > 0) {
    console.warn("Warning: annotation issues:", errors);
  }

  return annotated;
}
