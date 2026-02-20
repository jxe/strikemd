// State
let currentMarkdown = "";
let annotatedMarkdown = null;
let changes = [];
let dirty = false;

// --- Init ---

async function init() {
  const [fileResp, checksResp] = await Promise.all([
    fetch("/api/file").then((r) => r.json()),
    fetch("/api/checks").then((r) => r.json()),
  ]);

  currentMarkdown = fileResp.content;
  document.getElementById("file-name").textContent = fileResp.filePath
    .split("/")
    .pop();

  // Populate check dropdown
  const select = document.getElementById("check-select");
  for (const check of checksResp) {
    const opt = document.createElement("option");
    opt.value = check.name;
    opt.textContent = check.name;
    select.appendChild(opt);
  }

  // Render the plain markdown
  renderPlainMarkdown(currentMarkdown);

  // Wire up events
  select.addEventListener("change", () => {
    document.getElementById("run-btn").disabled = !select.value;
  });

  document.getElementById("run-btn").addEventListener("click", runCheck);
  document.getElementById("save-btn").addEventListener("click", saveFile);
  document.getElementById("accept-all-btn").addEventListener("click", acceptAll);
  document.getElementById("reject-all-btn").addEventListener("click", rejectAll);
}

// --- Render plain markdown ---

function renderPlainMarkdown(md) {
  const content = document.getElementById("content");
  content.innerHTML = marked.parse(stripFrontmatter(md));
  document.getElementById("sidebar").innerHTML = "";
  clearLines();
}

function stripFrontmatter(md) {
  const match = md.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1] : md;
}

// --- Run check ---

async function runCheck() {
  const checkName = document.getElementById("check-select").value;
  if (!checkName) return;

  const runBtn = document.getElementById("run-btn");
  runBtn.disabled = true;
  showLoading(true);
  setStatus("Running check...", "loading");

  try {
    const resp = await fetch("/api/annotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: currentMarkdown, checkName, model: document.getElementById("model-select").value }),
    });

    const data = await resp.json();
    if (data.error) {
      setStatus(`Error: ${data.error}`, "error");
      return;
    }

    annotatedMarkdown = data.annotated;
    changes = parseChanges(annotatedMarkdown);
    setStatus(`${changes.length} suggestion${changes.length !== 1 ? "s" : ""}`, "");

    renderAnnotated();
    showBulkButtons(true);
  } catch (err) {
    setStatus(`Error: ${err.message}`, "error");
  } finally {
    runBtn.disabled = false;
    showLoading(false);
  }
}

// --- Parse annotations ---

// Matches <strike> with <del>/<ins> in either order
const STRIKE_RE =
  /<strike\s+comment="([^"]*)">\s*(?:(?:<del>([\s\S]*?)<\/del>)\s*(?:<ins>([\s\S]*?)<\/ins>)?|(?:<ins>([\s\S]*?)<\/ins>)\s*(?:<del>([\s\S]*?)<\/del>)?)\s*<\/strike>/g;

function parseChanges(annotated) {
  const result = [];
  const re = new RegExp(STRIKE_RE.source, STRIKE_RE.flags);
  let match;
  while ((match = re.exec(annotated)) !== null) {
    // Groups 2,3 = del-first order; groups 4,5 = ins-first order
    const deleted = match[2] ?? match[5] ?? null;
    const inserted = match[3] ?? match[4] ?? null;
    result.push({
      index: result.length,
      comment: match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
      deleted,
      inserted,
      fullMatch: match[0],
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }
  return result;
}

// --- Render annotated document ---

function renderAnnotated() {
  if (!annotatedMarkdown) return;

  const content = document.getElementById("content");
  const sidebar = document.getElementById("sidebar");

  // Strip frontmatter, work only with the body
  const body = stripFrontmatter(annotatedMarkdown);

  // Strategy: replace <strike> blocks with unique placeholders, render the
  // markdown normally, then swap placeholders with styled HTML spans.
  // This gives proper markdown rendering (paragraphs, headings, lists, etc.)
  // without the fragments-of-markdown problem.

  const re = new RegExp(STRIKE_RE.source, STRIKE_RE.flags);
  const placeholders = [];
  let ci = 0;

  const withPlaceholders = body.replace(re, (fullMatch, comment, del1, ins1, ins2, del2) => {
    const placeholder = `STRIKE_PLACEHOLDER_${ci}`;
    const deleted = del1 ?? del2 ?? null;
    const inserted = ins1 ?? ins2 ?? null;
    placeholders.push({ ci, deleted, inserted });
    ci++;
    return placeholder;
  });

  // Render the markdown with placeholders
  let html = marked.parse(withPlaceholders);

  // Replace placeholders with styled spans
  for (const { ci, deleted, inserted } of placeholders) {
    const placeholder = `STRIKE_PLACEHOLDER_${ci}`;
    let replacement = `<span class="strike-anchor" data-ci="${ci}"></span>`;
    if (deleted !== null) {
      replacement += `<span class="strike-del" data-ci="${ci}">${escapeHtml(deleted)}</span>`;
    }
    if (inserted !== null) {
      replacement += `<span class="strike-ins" data-ci="${ci}">${escapeHtml(inserted)}</span>`;
    }
    html = html.replace(placeholder, replacement);
  }

  content.innerHTML = html;

  // Build sidebar cards
  sidebar.innerHTML = changes
    .map(
      (c, i) => `
    <div class="strike-card" data-ci="${i}">
      <div class="strike-card-comment">${escapeHtml(c.comment)}</div>
      <div class="strike-card-diff">
        ${c.deleted !== null ? `<div class="strike-card-del">${escapeHtml(truncate(c.deleted, 120))}</div>` : ""}
        ${c.inserted !== null ? `<div class="strike-card-ins" contenteditable="true" data-ci="${i}">${escapeHtml(c.inserted)}</div>` : ""}
      </div>
      <div class="strike-card-actions">
        <button class="btn-card-accept" data-ci="${i}">Accept</button>
        <button class="btn-card-reject" data-ci="${i}">Reject</button>
      </div>
    </div>
  `
    )
    .join("");

  // Wire up card actions
  sidebar.querySelectorAll(".btn-card-accept").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      acceptChange(parseInt(btn.dataset.ci));
    });
  });
  sidebar.querySelectorAll(".btn-card-reject").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      rejectChange(parseInt(btn.dataset.ci));
    });
  });

  // Stop clicks on editable ins text from triggering card click
  sidebar.querySelectorAll(".strike-card-ins[contenteditable]").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
  });

  // Wire up hover highlighting
  setupHoverHighlighting();

  // Draw connecting lines after layout settles
  requestAnimationFrame(() => {
    requestAnimationFrame(drawLines);
  });
}


// --- Accept / Reject ---

function acceptChange(ci) {
  const change = changes[ci];
  if (!change) return;

  // Read possibly-edited insertion text from the card
  const insEl = document.querySelector(`.strike-card-ins[data-ci="${ci}"]`);
  const insertedText = insEl ? insEl.textContent : change.inserted;

  // Update the annotated markdown: replace this change's annotation with inserted text
  annotatedMarkdown = annotatedMarkdown.replace(
    change.fullMatch,
    insertedText ?? ""
  );

  // Update currentMarkdown (strip frontmatter annotations, resolve this change)
  resolveCurrentMarkdown();

  // Re-parse and re-render
  changes = parseChanges(annotatedMarkdown);
  dirty = true;
  document.getElementById("save-btn").disabled = false;

  if (changes.length === 0) {
    renderPlainMarkdown(currentMarkdown);
    showBulkButtons(false);
    setStatus("All changes resolved", "");
  } else {
    renderAnnotated();
    setStatus(
      `${changes.length} suggestion${changes.length !== 1 ? "s" : ""} remaining`,
      ""
    );
  }
}

function rejectChange(ci) {
  const change = changes[ci];
  if (!change) return;

  // Replace this change's annotation with deleted text (keep original)
  annotatedMarkdown = annotatedMarkdown.replace(
    change.fullMatch,
    change.deleted ?? ""
  );

  resolveCurrentMarkdown();
  changes = parseChanges(annotatedMarkdown);
  dirty = true;
  document.getElementById("save-btn").disabled = false;

  if (changes.length === 0) {
    renderPlainMarkdown(currentMarkdown);
    showBulkButtons(false);
    setStatus("All changes resolved", "");
  } else {
    renderAnnotated();
    setStatus(
      `${changes.length} suggestion${changes.length !== 1 ? "s" : ""} remaining`,
      ""
    );
  }
}

function acceptAll() {
  if (!annotatedMarkdown) return;
  // Apply any user edits to insertion text before bulk-accepting
  for (const change of changes) {
    const insEl = document.querySelector(`.strike-card-ins[data-ci="${change.index}"]`);
    if (insEl) {
      const editedText = insEl.textContent;
      annotatedMarkdown = annotatedMarkdown.replace(change.fullMatch, editedText ?? "");
    } else {
      annotatedMarkdown = annotatedMarkdown.replace(change.fullMatch, change.inserted ?? "");
    }
  }
  resolveCurrentMarkdown();
  changes = [];
  dirty = true;
  document.getElementById("save-btn").disabled = false;
  renderPlainMarkdown(currentMarkdown);
  showBulkButtons(false);
  setStatus("All changes accepted", "");
}

function rejectAll() {
  if (!annotatedMarkdown) return;
  // Reject all remaining changes
  annotatedMarkdown = annotatedMarkdown.replace(
    new RegExp(STRIKE_RE.source, STRIKE_RE.flags),
    (_m, _comment, del1, _ins1, _ins2, del2) => del1 ?? del2 ?? ""
  );
  resolveCurrentMarkdown();
  changes = [];
  dirty = true;
  document.getElementById("save-btn").disabled = false;
  renderPlainMarkdown(currentMarkdown);
  showBulkButtons(false);
  setStatus("All changes rejected", "");
}

function resolveCurrentMarkdown() {
  // Current markdown is the annotated markdown with all resolved changes
  // Strip any remaining annotations by keeping deleted text (original)
  currentMarkdown = annotatedMarkdown.replace(
    new RegExp(STRIKE_RE.source, STRIKE_RE.flags),
    (_m, _comment, del1, _ins1, _ins2, del2) => del1 ?? del2 ?? ""
  );
}

// --- Save ---

async function saveFile() {
  try {
    setStatus("Saving...", "loading");
    const resp = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: currentMarkdown }),
    });
    const data = await resp.json();
    if (data.ok) {
      dirty = false;
      document.getElementById("save-btn").disabled = true;
      setStatus("Saved", "");
      showToast("File saved");
    } else {
      setStatus(`Save failed: ${data.error}`, "error");
    }
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, "error");
  }
}

// --- Hover highlighting ---

function setupHoverHighlighting() {
  // Inline elements → highlight card
  document.querySelectorAll(".strike-del, .strike-ins").forEach((el) => {
    el.addEventListener("mouseenter", () => {
      const ci = el.dataset.ci;
      highlightPair(ci, true);
    });
    el.addEventListener("mouseleave", () => {
      const ci = el.dataset.ci;
      highlightPair(ci, false);
    });
  });

  // Sidebar cards → highlight inline
  document.querySelectorAll(".strike-card").forEach((card) => {
    card.addEventListener("mouseenter", () => {
      highlightPair(card.dataset.ci, true);
    });
    card.addEventListener("mouseleave", () => {
      highlightPair(card.dataset.ci, false);
    });
    // Click card to scroll to inline change
    card.addEventListener("click", () => {
      const anchor = document.querySelector(
        `.strike-anchor[data-ci="${card.dataset.ci}"]`
      );
      if (anchor) {
        anchor.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });
}

function highlightPair(ci, on) {
  const method = on ? "add" : "remove";
  document
    .querySelectorAll(`[data-ci="${ci}"]`)
    .forEach((el) => el.classList[method]("highlight"));
  // Highlight connecting line
  const line = document.querySelector(`.strike-connector[data-ci="${ci}"]`);
  if (line) line.classList[method]("highlight");
}

// --- Connecting lines ---

function drawLines() {
  const svg = document.getElementById("lines");
  svg.innerHTML = "";

  document.querySelectorAll(".strike-card").forEach((card) => {
    const ci = card.dataset.ci;
    const anchor = document.querySelector(`.strike-anchor[data-ci="${ci}"]`);
    if (!anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();

    // Line from right edge of content to left edge of card
    const x1 = anchorRect.right;
    const y1 = anchorRect.top + anchorRect.height / 2;
    const x2 = cardRect.left;
    const y2 = cardRect.top + 16;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("data-ci", ci);
    line.setAttribute("class", "strike-connector");
    svg.appendChild(line);
  });
}

function clearLines() {
  document.getElementById("lines").innerHTML = "";
}

// Redraw lines on scroll/resize
window.addEventListener("scroll", () => requestAnimationFrame(drawLines));
window.addEventListener("resize", () => requestAnimationFrame(drawLines));

// --- Utilities ---

function setStatus(text, className) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = "status" + (className ? " " + className : "");
}

function showLoading(on) {
  let overlay = document.getElementById("loading-overlay");
  if (on) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "loading-overlay";
      overlay.className = "loading-overlay";
      overlay.innerHTML = '<span class="spinner"></span>Running AI check...';
      document.body.appendChild(overlay);
    }
  } else {
    if (overlay) overlay.remove();
  }
}

function showBulkButtons(on) {
  document.getElementById("accept-all-btn").style.display = on ? "" : "none";
  document.getElementById("reject-all-btn").style.display = on ? "" : "none";
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2500);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + "...";
}

// --- Start ---
init();
