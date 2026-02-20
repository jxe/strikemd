import Anthropic from "@anthropic-ai/sdk";
import type { Check } from "./checks";
import { validate } from "./parse";
import {
  splitIntoBlocks,
  formatBlocksForModel,
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

export type StreamEvent =
  | { type: "status"; message: string }
  | { type: "progress"; current: number; total: number; blockStatus: string }
  | { type: "done"; annotated: string }
  | { type: "error"; message: string };

export async function* streamAnnotation(
  markdown: string,
  check: Check,
  apiKey: string,
  model: string = DEFAULT_MODEL
): AsyncGenerator<StreamEvent> {
  try {
    const client = new Anthropic({ apiKey });

    // Split document into blocks
    const { frontmatter, blocks } = splitIntoBlocks(markdown);
    const numberedInput = formatBlocksForModel(blocks);
    const totalBlocks = blocks.length;

    console.log(`  ${totalBlocks} blocks`);
    yield { type: "status", message: `Analyzing ${totalBlocks} blocks...` };

    const systemPrompt = `${check.prompt}\n${ANNOTATION_INSTRUCTIONS}`;

    const stream = client.messages.stream({
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

    // Incremental state
    let textBuffer = "";
    let thinkingStarted = false;
    let textStarted = false;
    let completedBlocks = 0;
    const parsedOutput = new Map<number, string>();
    let currentNum: number | null = null;
    let currentContent = "";

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const blockType = event.content_block.type;
        if (blockType === "thinking" && !thinkingStarted) {
          thinkingStarted = true;
          yield { type: "status", message: "Thinking..." };
        } else if (blockType === "text" && !textStarted) {
          textStarted = true;
          yield { type: "status", message: `Reviewing blocks (0/${totalBlocks})...` };
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          textBuffer += event.delta.text;

          // Parse complete lines from the buffer
          let newlineIdx: number;
          while ((newlineIdx = textBuffer.indexOf("\n")) !== -1) {
            const line = textBuffer.slice(0, newlineIdx);
            textBuffer = textBuffer.slice(newlineIdx + 1);

            if (line.trim() === "") continue;

            const match = line.match(/^(\d+)\s+(.*)/);
            if (match) {
              // New numbered line — finalize previous block
              if (currentNum !== null) {
                parsedOutput.set(currentNum, currentContent.trim());
                completedBlocks++;
                const status = currentContent.trim() === "lgtm" ? "lgtm" : "changes";
                yield { type: "progress", current: completedBlocks, total: totalBlocks, blockStatus: status };
              }
              currentNum = parseInt(match[1], 10);
              currentContent = match[2];
            } else if (currentNum !== null) {
              // Continuation of current block (multi-line)
              currentContent += "\n" + line;
            }
          }
        }
      }
    }

    // Finalize any remaining text in the buffer (last line without trailing newline)
    if (textBuffer.trim()) {
      const match = textBuffer.match(/^(\d+)\s+(.*)/s);
      if (match) {
        if (currentNum !== null) {
          parsedOutput.set(currentNum, currentContent.trim());
          completedBlocks++;
          const status = currentContent.trim() === "lgtm" ? "lgtm" : "changes";
          yield { type: "progress", current: completedBlocks, total: totalBlocks, blockStatus: status };
        }
        currentNum = parseInt(match[1], 10);
        currentContent = match[2];
      } else if (currentNum !== null) {
        currentContent += "\n" + textBuffer;
      }
    }

    // Save the very last block
    if (currentNum !== null) {
      parsedOutput.set(currentNum, currentContent.trim());
      completedBlocks++;
      const status = currentContent.trim() === "lgtm" ? "lgtm" : "changes";
      yield { type: "progress", current: completedBlocks, total: totalBlocks, blockStatus: status };
    }

    // Reconstruct and validate
    yield { type: "status", message: "Reconstructing..." };

    const { annotated, warnings } = reconstruct(parsedOutput, frontmatter, blocks);
    for (const w of warnings) {
      console.warn("  ⚠", w);
    }

    const errors = validate(annotated);
    if (errors.length > 0) {
      console.warn("Warning: annotation issues:", errors);
    }

    console.log(`  ${completedBlocks}/${totalBlocks} blocks reviewed`);
    yield { type: "done", annotated };
  } catch (err: any) {
    console.error("Streaming error:", err);
    yield { type: "error", message: err.message ?? "AI request failed" };
  }
}
