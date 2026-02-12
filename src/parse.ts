export interface StrikeChange {
  comment: string;
  deleted: string | null;
  inserted: string | null;
  fullMatch: string;
  startOffset: number;
  endOffset: number;
}

// Matches <strike> with <del>/<ins> in either order
const STRIKE_RE =
  /<strike\s+comment="([^"]*)">\s*(?:(?:<del>([\s\S]*?)<\/del>)\s*(?:<ins>([\s\S]*?)<\/ins>)?|(?:<ins>([\s\S]*?)<\/ins>)\s*(?:<del>([\s\S]*?)<\/del>)?)\s*<\/strike>/g;

export function parseChanges(annotated: string): StrikeChange[] {
  const changes: StrikeChange[] = [];
  const re = new RegExp(STRIKE_RE.source, STRIKE_RE.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(annotated)) !== null) {
    // Groups 2,3 = del-first order; groups 4,5 = ins-first order
    const deleted = match[2] ?? match[5] ?? null;
    const inserted = match[3] ?? match[4] ?? null;
    changes.push({
      comment: match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
      deleted,
      inserted,
      fullMatch: match[0],
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  return changes;
}

export function recoverOriginal(annotated: string): string {
  return annotated.replace(
    new RegExp(STRIKE_RE.source, STRIKE_RE.flags),
    (_match, _comment, del1, _ins1, _ins2, del2) => del1 ?? del2 ?? ""
  );
}

export function acceptAll(annotated: string): string {
  return annotated.replace(
    new RegExp(STRIKE_RE.source, STRIKE_RE.flags),
    (_match, _comment, _del1, ins1, ins2, _del2) => ins1 ?? ins2 ?? ""
  );
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
  return annotated.replace(
    new RegExp(STRIKE_RE.source, STRIKE_RE.flags),
    (_match, _comment, del1, ins1, ins2, del2) => {
      return del1 ?? del2 ?? ins1 ?? ins2 ?? "";
    }
  );
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
  if (recovered.includes("<strike") || recovered.includes("<del>") || recovered.includes("<ins>")) {
    errors.push("Recovery left annotation artifacts — tags may be malformed");
  }

  return errors;
}
