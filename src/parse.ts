export interface Change {
  comment: string;
  deleted: string | null;
  inserted: string | null;
  fullMatch: string;
  startOffset: number;
  endOffset: number;
}

// Matches <del comment="..." [replaceWith="..."]>...</del> or <ins comment="...">...</ins>
const CHANGE_RE =
  /<(del|ins)\s+comment="([^"]*)"(?:\s+replaceWith="([^"]*)")?>([\s\S]*?)<\/\1>/g;

export function parseChanges(annotated: string): Change[] {
  const changes: Change[] = [];
  const re = new RegExp(CHANGE_RE.source, CHANGE_RE.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(annotated)) !== null) {
    const tag = match[1];           // "del" or "ins"
    const comment = match[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const replaceWith = match[3];   // undefined if not present
    const content = match[4];

    if (tag === "del") {
      changes.push({
        comment,
        deleted: content,
        inserted: replaceWith != null ? replaceWith.replace(/&quot;/g, '"').replace(/&amp;/g, "&") : null,
        fullMatch: match[0],
        startOffset: match.index,
        endOffset: match.index + match[0].length,
      });
    } else {
      // <ins>
      changes.push({
        comment,
        deleted: null,
        inserted: content,
        fullMatch: match[0],
        startOffset: match.index,
        endOffset: match.index + match[0].length,
      });
    }
  }

  return changes;
}

export function recoverOriginal(annotated: string): string {
  return annotated
    .replace(/<del\s+comment="[^"]*"(?:\s+replaceWith="[^"]*")?>([\s\S]*?)<\/del>/g, '$1')
    .replace(/<ins\s+comment="[^"]*">([\s\S]*?)<\/ins>/g, '');
}

export function acceptAll(annotated: string): string {
  return annotated
    .replace(/<del\s+comment="[^"]*"\s+replaceWith="([^"]*)">([\s\S]*?)<\/del>/g,
      (_m, replaceWith) => replaceWith.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    .replace(/<del\s+comment="[^"]*">([\s\S]*?)<\/del>/g, '')
    .replace(/<ins\s+comment="[^"]*">([\s\S]*?)<\/ins>/g, '$1');
}

export function applyDecisions(
  annotated: string,
  decisions: Map<number, "accept" | "reject">
): string {
  const changes = parseChanges(annotated);
  let result = "";
  let cursor = 0;

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    result += annotated.slice(cursor, change.startOffset);

    const decision = decisions.get(i);
    if (decision === "accept") {
      result += change.inserted ?? "";
    } else if (decision === "reject") {
      result += change.deleted ?? "";
    } else {
      result += change.fullMatch;
    }

    cursor = change.endOffset;
  }

  result += annotated.slice(cursor);
  return result;
}

export function stripAllAnnotations(annotated: string): string {
  return annotated
    .replace(/<del\s+comment="[^"]*"(?:\s+replaceWith="[^"]*")?>([\s\S]*?)<\/del>/g, '$1')
    .replace(/<ins\s+comment="[^"]*">([\s\S]*?)<\/ins>/g, '$1');
}

export function validate(annotated: string): string[] {
  const errors: string[] = [];
  const changes = parseChanges(annotated);

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.deleted === null && c.inserted === null) {
      errors.push(`Change ${i}: has neither deletion nor insertion`);
    }
  }

  const recovered = recoverOriginal(annotated);
  if (recovered.includes("<del ") || recovered.includes("<ins ")) {
    errors.push("Recovery left annotation artifacts — tags may be malformed");
  }

  return errors;
}
