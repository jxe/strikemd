# strikemd

AI-powered suggestion mode for markdown files. Run editorial checks and review changes Google Docs-style in the browser.

## Features

- 🔍 **AI editorial checks** — run prose checks like "remove redundancy", "hedge strong claims", "clarify unclear sentences" against any markdown file
- 📝 **Inline suggestions** — see deletions, insertions, and replacements rendered inline with your document
- ✅ **Accept/reject** — review each suggestion individually or bulk accept/reject all
- 💬 **Reviewer comments** — every suggestion includes an explanation of why the change improves the text
- 🔧 **Custom checks** — run `strikemd init` to customize which checks you use
- 🤖 **Model picker** — choose between Sonnet 4.6, Sonnet 4.5, Opus 4.6, or Haiku 4.5 in the UI
- 💾 **Save in place** — accepted changes write back to the original file

## Install

Requires [Bun](https://bun.sh).

```bash
bun install -g strikemd
```

## Usage

```bash
strikemd my-essay.md
```

This opens a browser UI where you pick a check and model, run it, and review the suggestions.

Pass an API key with `--key`, the `ANTHROPIC_API_KEY` env var, or a `.env` file.

```bash
strikemd my-essay.md --key sk-ant-...
```

Other commands:

```bash
strikemd init       # create .strikemd/checks.md with default checks
strikemd list       # list available checks
strikemd -v         # print version
```

## Built-in checks

- **Remove redundant sentences** — cut sentences that repeat a point or add no new information
- **Hedge too-strong claims** — qualify assertions that are stated too strongly
- **Replace rhetoric with substance** — swap emotional appeals for concrete statements
- **Activate passive voice** — rewrite passive constructions in active voice where it helps
- **Clarify unclear sentences** — rewrite ambiguous or hard-to-parse sentences
- **Make the download explicit** — turn abstract explanations into concrete frameworks

## Custom checks

Run `strikemd init` to copy the default checks into `.strikemd/checks.md`. Edit that file to add, remove, or rewrite checks. Each `# Heading` becomes a check name, and the body becomes the prompt:

```markdown
# Fix jargon

Find technical jargon that could be replaced with plain language. Rewrite for a general audience.

# Shorten paragraphs

Break paragraphs longer than 4 sentences into smaller ones.
```

When `.strikemd/checks.md` exists, it replaces the built-in checks entirely — only the checks in your file will appear.

## License

MIT
