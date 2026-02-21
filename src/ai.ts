import Anthropic from "@anthropic-ai/sdk";
import type { Check } from "./checks";
import { validate } from "./parse";
import {
  splitIntoBlocks,
  formatBlocksForModel,
  reconstruct,
} from "./reconstruct";

const ANNOTATION_INSTRUCTIONS = `
RESPONSE FORMAT — follow these rules exactly:

The document has been divided into numbered blocks. You will see each block prefixed with [N].

Respond with one line per block, in order. For each block:

If the block needs NO changes, write:
N lgtm

If the block needs changes, output the entire block text with annotation tags placed inline:
N the full block text with <del comment="why">text to remove</del> and <ins comment="why">text to add</ins> tags placed where changes occur

Annotation types:
- Replacement (preferred when replacing text): <del comment="why" replaceWith="new text">old text</del>
- Deletion (only when removing with no replacement): <del comment="why">text to remove</del>
- Insertion (only when adding with nothing removed): <ins comment="why">text to add</ins>

FORMATTING RULES:
- Include a line for every numbered block. Do not skip any.
- Do not include any preamble, commentary, or explanation. Just the numbered lines.
- For blocks with changes, output the complete block with annotation tags inline. Do not omit any text from the block.
- The text inside <del>...</del> must exactly match the original text at that position in the block.
- The comment attribute should briefly explain WHY (1-2 sentences).
- Use single quotes inside attributes to avoid escaping. If you must use double quotes, escape as &quot;
- Content inside tags and attributes is raw markdown.
- Preserve all LaTeX math, footnotes, citations, and formatting exactly.

OTHER INSTRUCTIONS:
- Make targeted changes. Do not rewrite passages unnecessarily.
- Try to infer the audience and purpose of the document and make improvements that fit the style and tone.`;

const DEFAULT_MODEL = "claude-opus-4-6"
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
