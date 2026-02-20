import Anthropic from "@anthropic-ai/sdk";
import type { Check } from "./checks";
import { validate } from "./parse";

const ANNOTATION_INSTRUCTIONS = `
RESPONSE FORMAT — you must follow these rules exactly:

Return the COMPLETE document with your suggested changes marked inline using this annotation format:

For replacements (old text → new text):
<strike comment="explanation"><del>old text</del><ins>new text</ins></strike>

For deletions (text removed):
<strike comment="explanation"><del>text to remove</del></strike>

For insertions (new text added):
<strike comment="explanation"><ins>new text to add</ins></strike>

RULES:
- Your response must begin with the document itself. Do NOT include any preamble, introduction, commentary, or explanation before or after the document.
- Return the ENTIRE document. Every part not being changed must appear unchanged.
- The comment attribute should briefly explain WHY the change improves the text (1-2 sentences).
- Content inside <del> and <ins> is raw markdown, not HTML-escaped.
- Do NOT modify the YAML frontmatter (the block between --- delimiters at the top).
- Do NOT split markdown syntax across change boundaries — each <del>/<ins> must contain complete markdown constructs.
- Preserve all LaTeX math ($...$, $$...$$), footnotes, citations, and formatting exactly.
- For changes inside fenced code blocks, replace the entire code block as a unit.
- Do NOT use double quotes inside the comment attribute — use single quotes instead.
- Make targeted changes. Do not rewrite passages unnecessarily.`;

const DEFAULT_MODEL = "claude-sonnet-4-6";

export async function runAnnotation(
  markdown: string,
  check: Check,
  apiKey: string,
  model: string = DEFAULT_MODEL
): Promise<string> {
  const client = new Anthropic({ apiKey });

  const systemPrompt = `${check.prompt}\n${ANNOTATION_INSTRUCTIONS}`;

  const message = await client.messages.create({
    model,
    max_tokens: 16384,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Here is the document to review:\n\n${markdown}`,
      },
    ],
  });

  let responseText =
    message.content[0].type === "text" ? message.content[0].text : "";

  // Strip any preamble before the frontmatter
  const fmIndex = responseText.indexOf("---");
  if (fmIndex > 0) {
    console.warn("Stripped AI preamble:", responseText.slice(0, fmIndex).trim());
    responseText = responseText.slice(fmIndex);
  }

  // Validate the response
  const errors = validate(responseText);
  if (errors.length > 0) {
    console.warn("Warning: AI response has annotation issues:", errors);
  }

  return responseText;
}
