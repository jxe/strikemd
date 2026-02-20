// State
let currentMarkdown = "";
let annotatedMarkdown = null;
let changes = [];
const history = [];
const MAX_HISTORY = 50;

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

  // Show debug panel if ?debug is in URL
  if (new URLSearchParams(location.search).has("debug")) {
    document.getElementById("debug-panel").style.display = "";
  }

  // Render the plain markdown
  renderPlainMarkdown(currentMarkdown);

  // Wire up events
  select.addEventListener("change", () => {
    document.getElementById("run-btn").disabled = !select.value;
  });

  document.getElementById("run-btn").addEventListener("click", runCheck);
  document.getElementById("accept-all-btn").addEventListener("click", () => { closeBulkDropdown(); acceptAll(); });
  document.getElementById("reject-all-btn").addEventListener("click", () => { closeBulkDropdown(); rejectAll(); });
  document.getElementById("undo-btn").addEventListener("click", undo);

  // Dropdown toggle
  document.querySelector("#bulk-actions .dropdown-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("bulk-actions").classList.toggle("open");
  });
  document.addEventListener("click", closeBulkDropdown);

  // Cmd+Z / Ctrl+Z for undo
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
  });
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
  showProgress(true);
  setStatus("", "");

  try {
    const resp = await fetch("/api/annotate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: currentMarkdown, checkName, model: document.getElementById("model-select").value }),
    });

    if (!resp.ok) {
      const data = await resp.json();
      setStatus(`Error: ${data.error}`, "error");
      return;
    }

    // Read SSE stream
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      let boundaryIdx;
      while ((boundaryIdx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundaryIdx);
        buffer = buffer.slice(boundaryIdx + 2);

        let eventType = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (!data) continue;

        handleStreamEvent(eventType, JSON.parse(data));
      }
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, "error");
  } finally {
    runBtn.disabled = false;
    showProgress(false);
  }
}

function handleStreamEvent(eventType, evt) {
  switch (eventType) {
    case "status":
      updateProgressText(evt.message);
      break;
    case "progress":
      updateProgressBar(evt.current, evt.total);
      updateProgressText(`Block ${evt.current}/${evt.total}: ${evt.blockStatus}`);
      break;
    case "done":
      annotatedMarkdown = evt.annotated;
      changes = parseChanges(annotatedMarkdown);
      setStatus(`${changes.length} suggestion${changes.length !== 1 ? "s" : ""}`, "");
      renderAnnotated();
      showBulkButtons(true);
      updateDebug();
      break;
    case "error":
      setStatus(`Error: ${evt.message}`, "error");
      break;
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

  // Sanitize any leftover <strike>/<del>/<ins> tags that the regex didn't match
  // (e.g. comment-only annotations with no <del>/<ins> inside)
  const sanitized = withPlaceholders
    .replace(/<strike[\s>]/g, (m) => "&lt;strike" + m.slice(7))
    .replace(/<\/strike>/g, "&lt;/strike&gt;")
    .replace(/<del>/g, "&lt;del&gt;")
    .replace(/<\/del>/g, "&lt;/del&gt;")
    .replace(/<ins>/g, "&lt;ins&gt;")
    .replace(/<\/ins>/g, "&lt;/ins&gt;");

  // Render the markdown with placeholders
  let html = marked.parse(sanitized);

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


// --- Undo / History ---

function pushHistory() {
  history.push({ annotatedMarkdown, currentMarkdown, changes: [...changes] });
  if (history.length > MAX_HISTORY) history.shift();
  document.getElementById("undo-btn").disabled = false;
}

function undo() {
  if (history.length === 0) return;
  const snapshot = history.pop();
  annotatedMarkdown = snapshot.annotatedMarkdown;
  currentMarkdown = snapshot.currentMarkdown;
  changes = snapshot.changes;

  document.getElementById("undo-btn").disabled = history.length === 0;

  if (changes.length === 0) {
    renderPlainMarkdown(currentMarkdown);
    showBulkButtons(false);
    setStatus("All changes resolved", "");
  } else {
    renderAnnotated();
    showBulkButtons(true);
    setStatus(`${changes.length} suggestion${changes.length !== 1 ? "s" : ""} remaining`, "");
  }
  saveFile();
}

// --- Accept / Reject ---

function acceptChange(ci) {
  const change = changes[ci];
  if (!change) return;

  pushHistory();

  // Read possibly-edited insertion text from the card
  const insEl = document.querySelector(`.strike-card-ins[data-ci="${ci}"]`);
  const insertedText = insEl ? insEl.textContent : change.inserted;

  annotatedMarkdown =
    annotatedMarkdown.slice(0, change.startOffset) +
    (insertedText ?? "") +
    annotatedMarkdown.slice(change.endOffset);
  afterMutation();
}

function rejectChange(ci) {
  const change = changes[ci];
  if (!change) return;

  pushHistory();

  annotatedMarkdown =
    annotatedMarkdown.slice(0, change.startOffset) +
    (change.deleted ?? "") +
    annotatedMarkdown.slice(change.endOffset);
  afterMutation();
}

function acceptAll() {
  if (!annotatedMarkdown) return;

  pushHistory();

  // Iterate in reverse so earlier offsets stay valid
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    const insEl = document.querySelector(`.strike-card-ins[data-ci="${change.index}"]`);
    const text = insEl ? insEl.textContent : change.inserted;
    annotatedMarkdown =
      annotatedMarkdown.slice(0, change.startOffset) +
      (text ?? "") +
      annotatedMarkdown.slice(change.endOffset);
  }
  afterMutation();
}

function rejectAll() {
  if (!annotatedMarkdown) return;

  pushHistory();

  annotatedMarkdown = annotatedMarkdown.replace(
    new RegExp(STRIKE_RE.source, STRIKE_RE.flags),
    (_m, _comment, del1, _ins1, _ins2, del2) => del1 ?? del2 ?? ""
  );
  afterMutation();
}

function afterMutation() {
  resolveCurrentMarkdown();
  changes = parseChanges(annotatedMarkdown);

  if (changes.length === 0) {
    renderPlainMarkdown(currentMarkdown);
    showBulkButtons(false);
    setStatus("All changes resolved", "");
  } else {
    renderAnnotated();
    showBulkButtons(true);
    setStatus(`${changes.length} suggestion${changes.length !== 1 ? "s" : ""} remaining`, "");
  }
  updateDebug();
  saveFile();
}

function resolveCurrentMarkdown() {
  currentMarkdown = annotatedMarkdown.replace(
    new RegExp(STRIKE_RE.source, STRIKE_RE.flags),
    (_m, _comment, del1, _ins1, _ins2, del2) => del1 ?? del2 ?? ""
  );
}

// --- Save ---

async function saveFile() {
  try {
    const resp = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: currentMarkdown }),
    });
    const data = await resp.json();
    if (!data.ok) {
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

function showProgress(on) {
  let overlay = document.getElementById("loading-overlay");
  if (on) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "loading-overlay";
      overlay.className = "loading-overlay";
      overlay.innerHTML = `
        <div class="progress-container">
          <div class="progress-bar-track">
            <div id="progress-bar-fill" class="progress-bar-fill"></div>
          </div>
          <div id="progress-text" class="progress-text">Starting...</div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
  } else {
    if (overlay) overlay.remove();
  }
}

function updateProgressBar(current, total) {
  const fill = document.getElementById("progress-bar-fill");
  if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
}

function updateProgressText(text) {
  const el = document.getElementById("progress-text");
  if (el) el.textContent = text;
}

function showBulkButtons(on) {
  const dropdown = document.getElementById("bulk-actions");
  dropdown.style.display = on ? "" : "none";
  dropdown.classList.remove("open");
}

function closeBulkDropdown() {
  document.getElementById("bulk-actions").classList.remove("open");
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2500);
}

function updateDebug() {
  const el = document.getElementById("debug-raw");
  if (el) el.value = annotatedMarkdown ?? "(null)";
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
