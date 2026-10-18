/**
 * public/app.js — RepoJudge frontend application
 *
 * Loaded as type="module" from index.html.
 * Section: Milestone 05 — Core shell, XSS-safe DOM helpers, and input panel
 *
 * SECURITY: Never uses innerHTML, outerHTML, insertAdjacentHTML,
 *           document.write, eval, or new Function anywhere.
 *           All dynamic content goes through textContent or the
 *           safe h() helper which only sets textContent + whitelisted attrs.
 */

"use strict";

// ============================================================
// § CONSTANTS & CRITERION META
// ============================================================

export const CRITERION_ORDER = [
  "clear_problem",
  "substantial_work",
  "easy_to_verify",
  "demo_explanation",
  "collaboration",
  "submission",
];

export const CRITERION_META = {
  clear_problem: {
    title: "Clear Problem Statement",
    desc: "Does the repository clearly articulate the problem being solved?",
    icon: "01",
  },
  substantial_work: {
    title: "Substantial Work",
    desc: "Is there evidence of meaningful development effort and commit history?",
    icon: "02",
  },
  easy_to_verify: {
    title: "Easy to Verify",
    desc: "Can evaluators clone, run, and inspect reproducible workflows?",
    icon: "03",
  },
  demo_explanation: {
    title: "Demo & Explanation",
    desc: "Is there a working demonstration, documentation, or architecture diagram?",
    icon: "04",
  },
  collaboration: {
    title: "Collaboration & Community",
    desc: "Does the repository follow open-source best practices and code standards?",
    icon: "05",
  },
  submission: {
    title: "Submission Integrity",
    desc: "Is the repository public, well-structured, and verified?",
    icon: "06",
  },
};

/** Sample repos for the "Try:" buttons */
export const SAMPLES = {
  real: {
    url: "https://github.com/github/gitignore",
    label: "github/gitignore (real public repo)",
  },
  fixture: {
    // XSS fixture — local demo only. Server returns stub data with hostile strings
    // to prove the UI renders them safely. Clearly labelled in UI.
    url: "https://github.com/xss-fixture/demo",
    label: "xss-fixture/demo (local demo fixture — not a live repo)",
  },
};

export const CLIENT_TIMEOUT_MS = 120_000;

// ============================================================
// § STATE MACHINE
// ============================================================
// States: "idle" | "loading" | "success" | "error"

let _state = "idle";
let _currentMode = "rules";

export function getState() { return _state; }

export function setState(next) {
  _state = next;
  applyStateToDOM();
}

function applyStateToDOM() {
  const heroSection   = qs("#hero");
  const loadingView   = qs("#loading-view");
  const errorView     = qs("#error-view");
  const resultsView   = qs("#results-view");

  // All hidden by default
  setClass(loadingView, "is-active", false);
  setClass(errorView,   "is-active", false);
  setClass(resultsView, "is-active", false);

  if (_state === "idle") {
    if (heroSection) heroSection.style.display = "";
    announceStatus("Ready. Enter a GitHub repository URL to begin.");
  } else if (_state === "loading") {
    if (heroSection) heroSection.style.display = "none";
    setClass(loadingView, "is-active", true);
    announceStatus("Analyzing repository, please wait…");
  } else if (_state === "success") {
    if (heroSection) heroSection.style.display = "none";
    setClass(resultsView, "is-active", true);
  } else if (_state === "error") {
    if (heroSection) heroSection.style.display = "none";
    setClass(errorView, "is-active", true);
  }
}

// ============================================================
// § DOM HELPERS — XSS-safe only
// ============================================================

/** querySelector shorthand */
export function qs(sel, root = document) {
  return root.querySelector(sel);
}

/** querySelectorAll shorthand */
export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/**
 * Safe element factory.
 * ONLY sets textContent and a whitelist of safe attributes.
 * NEVER touches innerHTML or outerHTML.
 */
export function h(tag, attrs = {}, children = []) {
  const SAFE_ATTRS = new Set([
    "class", "id", "type", "href", "target", "rel", "aria-label",
    "aria-hidden", "aria-expanded", "aria-controls", "aria-live",
    "aria-atomic", "aria-describedby", "aria-invalid", "role",
    "tabindex", "open", "data-criterion", "style", "for",
    "title", "name", "value", "disabled",
  ]);

  const el = document.createElement(tag);

  for (const [key, val] of Object.entries(attrs)) {
    if (!SAFE_ATTRS.has(key)) continue; // silently ignore unsafe attrs
    if (key === "href") {
      const v = String(val);
      if (
        v.startsWith("#") ||
        v.startsWith("/") ||
        isSafeExternalUrl(v)
      ) {
        el.setAttribute("href", v);
      }
    } else if (key === "style") {
      const v = String(val);
      if (!/url\s*\(|expression\s*\(/i.test(v)) {
        el.setAttribute("style", v);
      }
    } else {
      el.setAttribute(key, String(val));
    }
  }

  const items = Array.isArray(children) ? children : [children];
  for (const child of items) {
    if (typeof child === "string") {
      el.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  }

  return el;
}

/** Set/unset a CSS class */
export function setClass(el, cls, on) {
  if (!el) return;
  if (on) el.classList.add(cls);
  else el.classList.remove(cls);
}

/** Announce text to screen readers via aria-live */
export function announceStatus(text) {
  const r = qs("#status-region");
  if (!r) return;
  r.textContent = "";
  requestAnimationFrame(() => { r.textContent = text; });
}

/** Announce copy confirmation */
export function announceCopy(text) {
  const r = qs("#copy-region");
  if (!r) return;
  r.textContent = "";
  requestAnimationFrame(() => { r.textContent = text; });
}

/** Validate safe external URL */
export function isSafeExternalUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === "https:" && p.hostname === "github.com";
  } catch {
    return false;
  }
}

/** Format a repo name from URL safely */
export function repoNameFromUrl(url) {
  try {
    const p = new URL(url);
    const parts = p.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    if (parts.length === 1) return parts[0];
    return url;
  } catch {
    return String(url);
  }
}

/** Format ISO date safely */
export function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

// ============================================================
// § CLIENT URL VALIDATION
// ============================================================

const GITHUB_PATH_RE = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})\/?(?:\.git)?$/;

export function validateUrl(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: "Please enter a GitHub repository URL." };
  if (trimmed.length > 200) return { ok: false, message: "URL is too long (max 200 characters)." };

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: "Not a valid URL. Example: https://github.com/owner/repo" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, message: "Only https:// URLs are accepted." };
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return { ok: false, message: "URL must be a github.com repository." };
  }
  if (!GITHUB_PATH_RE.test(parsed.pathname)) {
    return { ok: false, message: "Path must be exactly /owner/repo — no extra segments." };
  }
  return { ok: true, message: "" };
}

// ============================================================
// § DETERMINISTIC RULE CARDS & EVIDENCE PANELS
// ============================================================

export function makeCheckOrXIcon(pass) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "rule-status__icon");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", pass ? "#22c55e" : "#ef4444");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  if (pass) {
    const poly = document.createElementNS(ns, "polyline");
    poly.setAttribute("points", "20 6 9 17 4 12");
    svg.appendChild(poly);
  } else {
    const l1 = document.createElementNS(ns, "line");
    l1.setAttribute("x1", "18"); l1.setAttribute("y1", "6");
    l1.setAttribute("x2", "6");  l1.setAttribute("y2", "18");
    const l2 = document.createElementNS(ns, "line");
    l2.setAttribute("x1", "6");  l2.setAttribute("y1", "6");
    l2.setAttribute("x2", "18"); l2.setAttribute("y2", "18");
    svg.appendChild(l1);
    svg.appendChild(l2);
  }
  return svg;
}

export function buildEvidencePanel(summaryText, bodyEl) {
  const details = h("details", { class: "evidence-panel" });

  const summary = h("summary");
  summary.textContent = summaryText;

  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("class", "evidence-panel__chevron");
  chevron.setAttribute("width", "14");
  chevron.setAttribute("height", "14");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.setAttribute("fill", "none");
  chevron.setAttribute("stroke", "currentColor");
  chevron.setAttribute("stroke-width", "2");
  chevron.setAttribute("stroke-linecap", "round");
  chevron.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  path.setAttribute("points", "6 9 12 15 18 9");
  chevron.appendChild(path);
  summary.appendChild(chevron);

  const body = h("div", { class: "evidence-panel__body" });
  body.appendChild(bodyEl);

  details.appendChild(summary);
  details.appendChild(body);
  return details;
}

export function buildCriterionCard(criterionId, rules, verdict, mode) {
  const meta = CRITERION_META[criterionId] ?? {
    title: criterionId,
    desc: "",
    icon: "●",
  };

  const card = h("article", {
    class: "criterion-card reveal",
    role: "listitem",
    "data-criterion": criterionId,
  });

  // Card header
  const header = h("div", { class: "criterion-card__header" });
  const iconEl = h("div", { class: "criterion-icon", "aria-hidden": "true" });
  iconEl.textContent = meta.icon;

  const titleGroup = h("div", { class: "criterion-card__title-group" });
  const titleEl = h("h3", { class: "criterion-card__title" });
  titleEl.textContent = meta.title;
  const descEl = h("p", { class: "criterion-card__desc" });
  descEl.textContent = meta.desc;
  titleGroup.appendChild(titleEl);
  titleGroup.appendChild(descEl);

  header.appendChild(iconEl);
  header.appendChild(titleGroup);
  card.appendChild(header);

  // Card body
  const body = h("div", { class: "criterion-card__body" });

  // Deterministic rules section
  const rulesSection = h("div", { class: "criterion-section" });
  const rulesLabel = h("div", { class: "criterion-section__label" });
  rulesLabel.textContent = "Deterministic checks";
  rulesSection.appendChild(rulesLabel);

  const criterionRules = rules.filter((r) => r.criterion === criterionId);

  if (criterionRules.length === 0) {
    const empty = h("p", { class: "text-tertiary text-sm" });
    empty.textContent = "No checks for this criterion.";
    rulesSection.appendChild(empty);
  } else {
    const ruleList = h("div", { class: "rule-list" });
    for (const rule of criterionRules) {
      const item = h("div", { class: `rule-item ${rule.pass ? "is-pass" : "is-fail"}` });

      const statusEl = h("div", { class: "rule-status" });
      const iconSvg = makeCheckOrXIcon(rule.pass);
      statusEl.appendChild(iconSvg);
      const statusText = h("span", { class: "rule-status__text" });
      statusText.textContent = rule.pass ? "Pass" : "Fail";
      statusEl.appendChild(statusText);

      const content = h("div", { class: "rule-content" });
      const idEl = h("span", { class: "rule-id" });
      idEl.textContent = rule.id;
      content.appendChild(idEl);

      const evidenceBody = h("p", { class: "evidence-text" });
      evidenceBody.textContent = rule.evidence;
      const panel = buildEvidencePanel("Evidence", evidenceBody);
      content.appendChild(panel);

      item.appendChild(statusEl);
      item.appendChild(content);
      ruleList.appendChild(item);
    }
    rulesSection.appendChild(ruleList);
  }

  body.appendChild(rulesSection);

  // AI verdict section
  const gemmaSection = h("div", { class: "criterion-section" });
  const gemmaLabel = h("div", { class: "criterion-section__label" });
  gemmaLabel.textContent = "AI assessment (advisory)";

  const dot = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  dot.setAttribute("width", "8");
  dot.setAttribute("height", "8");
  dot.setAttribute("viewBox", "0 0 8 8");
  dot.setAttribute("aria-hidden", "true");
  const dotCirc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dotCirc.setAttribute("cx", "4");
  dotCirc.setAttribute("cy", "4");
  dotCirc.setAttribute("r", "3");
  dotCirc.setAttribute("fill", "#7c5cff");
  dot.appendChild(dotCirc);
  gemmaLabel.insertBefore(dot, gemmaLabel.firstChild);
  gemmaSection.appendChild(gemmaLabel);

  if (mode === "rules") {
    const note = h("div", { class: "verdict-rules-only" });
    note.textContent = "Not evaluated in Rules Only mode — no AI call was made.";
    gemmaSection.appendChild(note);
  } else if (!verdict) {
    const unscored = h("div", { class: "verdict-unscored" });
    const warnIcon = makeWarnIcon();
    const warnText = h("span");
    warnText.textContent = "Not scored — this criterion was not returned by the model.";
    unscored.appendChild(warnIcon);
    unscored.appendChild(warnText);
    gemmaSection.appendChild(unscored);
  } else {
    const verdictWrap = h("div", { class: "verdict-wrap" });
    const verdictHeader = h("div", { class: "verdict-header" });

    const ring = buildScoreRing(verdict.score);
    verdictHeader.appendChild(ring);

    const verdictInfo = h("div", { class: "flex flex-col gap-2" });

    const reasoningEl = h("p", { class: "evidence-text" });
    reasoningEl.textContent = verdict.reasoning;
    const reasoningPanel = buildEvidencePanel("Reasoning", reasoningEl);
    verdictInfo.appendChild(reasoningPanel);

    if (verdict.evidence && verdict.evidence.length > 0) {
      const evList = h("ul", { class: "evidence-list" });
      for (const ev of verdict.evidence) {
        const li = h("li", { class: "evidence-list__item" });
        li.textContent = ev;
        evList.appendChild(li);
      }
      const evPanel = buildEvidencePanel(`Evidence (${verdict.evidence.length})`, evList);
      verdictInfo.appendChild(evPanel);
    }

    if (verdict.suggestion) {
      const sugPanel = buildEvidencePanel("Suggestion", (() => {
        const s = h("p", { class: "suggestion-text" });
        s.textContent = verdict.suggestion;
        return s;
      })());
      verdictInfo.appendChild(sugPanel);
    }

    verdictHeader.appendChild(verdictInfo);
    verdictWrap.appendChild(verdictHeader);
    gemmaSection.appendChild(verdictWrap);
  }

  body.appendChild(gemmaSection);
  card.appendChild(body);

  return card;
}

export function makeWarnIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "verdict-unscored__icon");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "#f59e0b");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z");
  const l1 = document.createElementNS(ns, "line");
  l1.setAttribute("x1", "12"); l1.setAttribute("y1", "9");
  l1.setAttribute("x2", "12"); l1.setAttribute("y2", "13");
  const l2 = document.createElementNS(ns, "line");
  l2.setAttribute("x1", "12"); l2.setAttribute("y1", "17");
  l2.setAttribute("x2", "12.01"); l2.setAttribute("y2", "17");
  svg.appendChild(path);
  svg.appendChild(l1);
  svg.appendChild(l2);
  return svg;
}

export function buildScoreRing(score) {
  const RADIUS = 26;
  const CIRC = 2 * Math.PI * RADIUS;
  const pct = Math.max(0, Math.min(5, score)) / 5;
  const offset = CIRC * (1 - pct);

  const colors = ["#ef4444","#f97316","#eab308","#84cc16","#22c55e","#5ce1ff"];
  const color = colors[Math.max(0, Math.min(5, Math.round(score)))] ?? "#9aa4c0";

  const wrap = h("div", {
    class: "score-ring-wrap",
    "aria-label": `Score: ${score} out of 5`,
    role: "img",
  });

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "score-ring");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", "64");
  svg.setAttribute("height", "64");
  svg.setAttribute("aria-hidden", "true");

  const track = document.createElementNS(ns, "circle");
  track.setAttribute("class", "score-ring__track");
  track.setAttribute("cx", "32");
  track.setAttribute("cy", "32");
  track.setAttribute("r", String(RADIUS));
  svg.appendChild(track);

  const fill = document.createElementNS(ns, "circle");
  fill.setAttribute("class", "score-ring__fill");
  fill.setAttribute("cx", "32");
  fill.setAttribute("cy", "32");
  fill.setAttribute("r", String(RADIUS));
  fill.setAttribute("stroke-dasharray", String(CIRC));
  fill.setAttribute("stroke-dashoffset", String(CIRC));
  fill.setAttribute("stroke", color);
  svg.appendChild(fill);

  wrap.appendChild(svg);

  const textWrap = h("div", { class: "score-ring__text", "aria-hidden": "true" });
  textWrap.textContent = String(score);
  wrap.appendChild(textWrap);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.transition = "stroke-dashoffset 600ms cubic-bezier(0.16, 1, 0.3, 1)";
      fill.setAttribute("stroke-dashoffset", String(offset));
    });
  });

  return wrap;
}

export function buildPlainTextSummary(scorecard) {
  const { repo, mode, rules, verdicts, unscored, total, generatedAt, customRules } = scorecard;
  const lines = [
    "RepoJudge Evaluation Summary",
    "============================",
    `Repository: ${repo}`,
    `Mode: ${mode}`,
    `Generated: ${generatedAt}`,
    "",
    "Rules",
    "-----",
  ];

  for (const rule of rules) {
    lines.push(`[${rule.pass ? "PASS" : "FAIL"}] ${rule.id} (${rule.criterion}): ${rule.evidence}`);
  }

  const passCount = rules.filter((r) => r.pass).length;
  lines.push(`\nResult: ${passCount} of ${rules.length} rules passed`);

  if ((mode === "rules+ai" || mode === "rules+gemma") && verdicts && verdicts.length > 0) {
    lines.push("\nAI Verdicts (advisory)", "-".repeat(28));
    for (const v of verdicts) {
      lines.push(`[${v.criterion}] Score: ${v.score}/5`);
      lines.push(`  Reasoning: ${v.reasoning}`);
      if (v.suggestion) lines.push(`  Suggestion: ${v.suggestion}`);
    }
  }

  if (unscored && unscored.length > 0) {
    lines.push(`\nNot scored: ${unscored.join(", ")}`);
  }

  if (customRules && customRules.length > 0) {
    lines.push("\nCustom Specification Checks", "-".repeat(28));
    for (const cr of customRules) {
      lines.push(`[${cr.pass ? "PASS" : "FAIL"}] ${cr.name || cr.id} (${cr.type}): ${cr.evidence}`);
    }
    const crPass = customRules.filter((r) => r.pass).length;
    lines.push(`Result: ${crPass} of ${customRules.length} custom checks passed`);
  }

  if (total !== null && typeof total === "number" && isFinite(total)) {
    lines.push(`\nTotal Score: ${total} / 30`);
  } else if (mode === "rules+ai" || mode === "rules+gemma") {
    lines.push("\nTotal: unavailable (some criteria not scored)");
  }

  lines.push("\nJudge model: Open-weight AI (Groq, OpenRouter, Ollama).");
  return lines.join("\n");
}

export function initCopyButton() {
  const btn = qs("#copy-btn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    if (!_lastScorecard) return;
    const text = buildPlainTextSummary(_lastScorecard);

    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "✓ Copied!";
      announceCopy("Summary copied to clipboard.");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
        btn.textContent = "✓ Copied!";
        announceCopy("Summary copied to clipboard.");
      } catch {
        btn.textContent = "Copy failed";
        announceCopy("Could not copy. Please select and copy manually.");
      }
      document.body.removeChild(ta);
    }

    setTimeout(() => {
      btn.textContent = "";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("width", "14"); icon.setAttribute("height", "14");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "2");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("aria-hidden", "true");
      const r1 = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r1.setAttribute("x", "9"); r1.setAttribute("y", "9");
      r1.setAttribute("width", "13"); r1.setAttribute("height", "13");
      r1.setAttribute("rx", "2"); r1.setAttribute("ry", "2");
      const pth = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pth.setAttribute("d", "M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1");
      icon.appendChild(r1);
      icon.appendChild(pth);
      btn.appendChild(icon);
      btn.appendChild(document.createTextNode(" Copy summary"));
    }, 2000);
  });
}

// ============================================================
// § RESULTS DASHBOARD RENDERING
// ============================================================

export function buildBadge(text, cls) {
  const badge = h("span", { class: `badge ${cls}` });
  badge.textContent = text;
  return badge;
}

export function renderResults(scorecard, dataSource) {
  const { repo, mode, rules, verdicts, unscored, total, model, generatedAt } = scorecard;

  // Stub banner
  const stubBanner = qs("#stub-banner");
  const stubBannerText = qs("#stub-banner-text");
  if (stubBanner && stubBannerText) {
    if (dataSource === "stub") {
      stubBanner.style.display = "";
      stubBannerText.textContent =
        "Demo data: stub modules active — not a live evaluation. Results are synthetic for demonstration purposes.";
    } else {
      stubBanner.style.display = "none";
    }
  }

  // Repo name + link
  const repoDisplay = qs("#results-repo-display");
  if (repoDisplay) {
    const name = repoNameFromUrl(repo);
    if (isSafeExternalUrl(repo)) {
      const link = h("a", {
        href: repo,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": `Open ${name} on GitHub (opens in new tab)`,
      });
      link.textContent = name;
      repoDisplay.textContent = "";
      repoDisplay.appendChild(link);
    } else {
      repoDisplay.textContent = name;
    }
  }

  // Meta badges
  const metaEl = qs("#results-meta");
  if (metaEl) {
    metaEl.textContent = "";
    const isAi = mode === "rules+ai" || mode === "rules+gemma";
    metaEl.appendChild(
      buildBadge(
        isAi ? "Rules + AI" : "Rules Only",
        isAi ? "badge--ai" : "badge--rules"
      )
    );
    const timeBadge = buildBadge(`Generated: ${formatDate(generatedAt)}`, "badge--time");
    metaEl.appendChild(timeBadge);
    if (model) {
      const modelBadge = buildBadge(`Model: ${model.name}`, "badge--ai");
      metaEl.appendChild(modelBadge);
    }
  }

  // Total score block
  const totalBlock = qs("#results-total-block");
  if (totalBlock) {
    totalBlock.textContent = "";
    if (mode === "rules") {
      const totalWrap = h("div", { class: "results-total" });
      const lbl = h("span", { class: "results-total__label" });
      lbl.textContent = "Built-in Total";
      const val = h("span", { class: "results-total__value" });
      if (typeof total === "number" && isFinite(total)) {
        val.textContent = `${total} / 30`;
      } else {
        val.textContent = "—";
      }
      totalWrap.appendChild(lbl);
      totalWrap.appendChild(val);
      totalBlock.appendChild(totalWrap);
    } else if (total !== null && typeof total === "number" && isFinite(total)) {
      const totalWrap = h("div", { class: "results-total" });
      const lbl = h("span", { class: "results-total__label" });
      lbl.textContent = "Built-in Total";
      const val = h("span", { class: "results-total__value" });
      val.textContent = `${total} / 30`;
      totalWrap.appendChild(lbl);
      totalWrap.appendChild(val);
      totalBlock.appendChild(totalWrap);
    } else {
      const unavailWrap = h("div", { class: "results-total" });
      const icon = makeWarnIcon();
      const msg = h("div");
      const msgLine = h("p", { class: "results-total--unavailable text-sm" });
      msgLine.textContent =
        "Total unavailable: one or more criteria were not scored.";
      msg.appendChild(msgLine);
      if (unscored && unscored.length > 0) {
        const unscoredList = h("p", { class: "text-xs text-tertiary mt-4" });
        unscoredList.textContent = `Not scored: ${unscored.join(", ")}`;
        msg.appendChild(unscoredList);
      }
      unavailWrap.appendChild(icon);
      unavailWrap.appendChild(msg);
      totalBlock.appendChild(unavailWrap);
    }
  }

  // Summary bar
  const passCount   = rules.filter((r) => r.pass).length;
  const failCount   = rules.filter((r) => !r.pass).length;
  const scoredCount = (verdicts ?? []).length;
  const unscoredCount = (unscored ?? []).length;

  const statPass   = qs("#stat-pass-count");
  const statFail   = qs("#stat-fail-count");
  const statScored = qs("#stat-scored-count");
  const statUnscored = qs("#stat-unscored-count");

  if (statPass)     statPass.textContent     = String(passCount);
  if (statFail)     statFail.textContent     = String(failCount);
  if (statScored)   statScored.textContent   = String(scoredCount);
  if (statUnscored) statUnscored.textContent = String(unscoredCount);

  // Criteria grid
  const grid = qs("#criteria-grid");
  if (grid) {
    grid.textContent = "";

    const verdictMap = {};
    for (const v of (verdicts ?? [])) {
      verdictMap[v.criterion] = v;
    }

    for (const cid of CRITERION_ORDER) {
      const criterionRules = rules.filter((r) => r.criterion === cid);
      const verdict = verdictMap[cid] ?? null;
      const card = buildCriterionCard(cid, criterionRules, verdict, mode);
      grid.appendChild(card);
    }
  }

  // Custom checks section
  const customSection = qs("#custom-checks-section");
  const customBadge = qs("#custom-checks-badge");
  const customGrid = qs("#custom-checks-grid");
  const customResults = scorecard.customRules ?? [];

  if (customSection && customGrid) {
    if (customResults.length > 0) {
      customSection.style.display = "";
      if (customBadge) {
        customBadge.textContent = `${customResults.length} check${customResults.length === 1 ? "" : "s"}`;
      }
      customGrid.textContent = "";

      for (const cr of customResults) {
        const card = h("div", {
          class: `custom-check-card ${cr.pass ? "custom-check-card--pass" : "custom-check-card--fail"}`,
          role: "listitem",
        });

        const top = h("div", { class: "custom-check-card__top" });
        const nameGroup = h("div", { class: "custom-check-card__name" });
        nameGroup.appendChild(makeCheckOrXIcon(cr.pass));

        const titleText = h("span");
        titleText.textContent = cr.name || cr.id;
        nameGroup.appendChild(titleText);

        const typeBadge = h("span", { class: "custom-rule-item__type" });
        typeBadge.textContent = cr.type;
        nameGroup.appendChild(typeBadge);

        const passBadge = h("span", {
          class: `custom-check-card__badge ${cr.pass ? "custom-check-card__badge--pass" : "custom-check-card__badge--fail"}`,
        });
        passBadge.textContent = cr.pass ? "PASS" : "FAIL";

        top.appendChild(nameGroup);
        top.appendChild(passBadge);
        card.appendChild(top);

        if (cr.description) {
          const desc = h("p", { class: "custom-check-card__desc" });
          desc.textContent = cr.description;
          card.appendChild(desc);
        }

        const evidence = h("div", { class: "custom-check-card__evidence" });
        evidence.textContent = cr.evidence || "No evidence recorded.";
        card.appendChild(evidence);

        customGrid.appendChild(card);
      }
    } else {
      customSection.style.display = "none";
    }
  }

  initReveal();

  const heading = qs("#results-heading");
  if (heading) {
    heading.focus();
    heading.setAttribute("tabindex", "-1");
  }

  announceStatus(
    `Evaluation complete. ${passCount} of ${rules.length} rules passed.` +
    (customResults.length > 0 ? ` ${customResults.filter((r) => r.pass).length} of ${customResults.length} custom checks passed.` : "") +
    ((mode === "rules+ai" || mode === "rules+gemma")
      ? ` ${scoredCount} criteria scored by AI.`
      : " Rules Only mode — no AI call was made.")
  );
}

// ============================================================
// § API
// ============================================================

export async function fetchJudge(url, mode, signal, apiKey, customRules) {
  const payload = { url, mode };
  if (apiKey && apiKey.trim().length > 0) {
    payload.apiKey = apiKey.trim();
  }
  if (customRules && Array.isArray(customRules) && customRules.length > 0) {
    payload.customRules = customRules;
  }

  const response = await fetch("/api/judge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  const dataSource = response.headers.get("X-RepoJudge-Data-Source") ?? "live";

  if (!response.ok) {
    let errorText = "Evaluation failed.";
    let retryAfter = null;
    try {
      const body = await response.json();
      if (body && typeof body.error === "string") {
        errorText = body.error;
      }
    } catch {
      errorText = `Request failed (HTTP ${response.status}).`;
    }
    if (response.status === 429) {
      retryAfter = response.headers.get("Retry-After");
    }
    const err = new Error(errorText);
    err.status = response.status;
    err.retryAfter = retryAfter;
    throw err;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Server returned an unreadable response.");
  }

  return { scorecard: data, dataSource };
}

export function showError(message, retryAfter = null) {
  const msgEl = qs("#error-message");
  const retryHint = qs("#retry-after-hint");

  if (msgEl) msgEl.textContent = String(message);

  if (retryHint) {
    if (retryAfter) {
      retryHint.textContent = `Please wait ${retryAfter} second(s) before retrying.`;
      retryHint.style.display = "";
    } else {
      retryHint.textContent = "";
      retryHint.style.display = "none";
    }
  }

  setState("error");

  const errorHeading = qs("#error-heading");
  if (errorHeading) {
    errorHeading.focus();
    errorHeading.setAttribute("tabindex", "-1");
  }

  announceStatus(`Error: ${String(message)}`);
}

let _currentAbortController = null;
let _lastScorecard = null;

export function getLastScorecard() { return _lastScorecard; }
export function setLastScorecard(sc) { _lastScorecard = sc; }

// ============================================================
// § CUSTOM RULES MANAGEMENT
// ============================================================

export const DEFAULT_CUSTOM_RULES = [
  {
    id: "custom.env_missing",
    name: "No Committed Secrets (.env Missing)",
    description: "Ensure that sensitive .env files are not checked into the repository",
    type: "file_missing",
    path: ".env",
    weight: 1,
  },
  {
    id: "custom.readme_has_license",
    name: "README Mentions License",
    description: "Check if the README contains a License section",
    type: "file_contains",
    path: "README.md",
    pattern: "license",
    isRegex: false,
    weight: 1,
  },
  {
    id: "custom.source_ts_count",
    name: "Source Files Minimum Count",
    description: "Ensure that there are at least 3 TypeScript files in src",
    type: "file_count",
    pattern: "src/**/*.ts",
    min: 3,
    weight: 1,
  },
];

const LOCAL_STORAGE_RULES_KEY = "reposcore_custom_rules";

export function loadCustomRules() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_RULES_KEY);
    if (!raw) return DEFAULT_CUSTOM_RULES;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
    return DEFAULT_CUSTOM_RULES;
  } catch {
    return DEFAULT_CUSTOM_RULES;
  }
}

export function saveCustomRules(rules) {
  try {
    localStorage.setItem(LOCAL_STORAGE_RULES_KEY, JSON.stringify(rules));
  } catch (err) {
    console.error("Failed to save custom rules:", err);
  }
}

function getRuleSummaryDetails(rule) {
  switch (rule.type) {
    case "file_exists":
    case "file_missing":
      return `Path: ${rule.path || ""}`;
    case "file_contains":
      return `Path: ${rule.path || ""} | Pattern: "${rule.pattern || ""}"${rule.isRegex ? " (regex)" : ""}`;
    case "file_count":
      return `Glob: ${rule.pattern || ""} | Min: ${rule.min ?? "—"}, Max: ${rule.max ?? "—"}`;
    case "json_field_equals":
      return `${rule.path || ""} → ${rule.field || ""} = ${JSON.stringify(rule.expectedValue)}`;
    default:
      return "";
  }
}

function renderRuleParamsForm(container, type, initial = {}) {
  container.textContent = "";

  if (type === "file_exists" || type === "file_missing") {
    const field = h("div", { class: "custom-rule-form__field" });
    const lbl = h("label", { for: "rule-param-path" });
    lbl.textContent = type === "file_exists" ? "File Path to Check" : "Forbidden File Path";
    const inp = h("input", {
      type: "text",
      id: "rule-param-path",
      class: "input-text",
      value: initial.path || (type === "file_missing" ? ".env" : "Dockerfile"),
      placeholder: "e.g. Dockerfile or .env",
    });
    field.appendChild(lbl);
    field.appendChild(inp);
    container.appendChild(field);
  } else if (type === "file_contains") {
    const row = h("div", { class: "custom-rule-form__row" });
    const pathField = h("div", { class: "custom-rule-form__field" });
    const pathLbl = h("label", { for: "rule-param-path" });
    pathLbl.textContent = "File Path";
    const pathInp = h("input", {
      type: "text",
      id: "rule-param-path",
      class: "input-text",
      value: initial.path || "README.md",
      placeholder: "e.g. README.md",
    });
    pathField.appendChild(pathLbl);
    pathField.appendChild(pathInp);

    const patField = h("div", { class: "custom-rule-form__field" });
    const patLbl = h("label", { for: "rule-param-pattern" });
    patLbl.textContent = "Pattern / String to Match";
    const patInp = h("input", {
      type: "text",
      id: "rule-param-pattern",
      class: "input-text",
      value: initial.pattern || "",
      placeholder: "e.g. License or v[0-9]+",
    });
    patField.appendChild(patLbl);
    patField.appendChild(patInp);

    row.appendChild(pathField);
    row.appendChild(patField);
    container.appendChild(row);

    const regexWrap = h("div", { style: "margin-top:0.4rem; display:flex; align-items:center; gap:0.5rem;" });
    const chk = h("input", {
      type: "checkbox",
      id: "rule-param-is-regex",
    });
    if (initial.isRegex) chk.setAttribute("checked", "true");
    const chkLbl = h("label", { for: "rule-param-is-regex", style: "font-size:11px; font-family:var(--font-mono); color:var(--c-text-secondary); cursor:pointer;" });
    chkLbl.textContent = "Treat Pattern as Regular Expression";
    regexWrap.appendChild(chk);
    regexWrap.appendChild(chkLbl);
    container.appendChild(regexWrap);
  } else if (type === "file_count") {
    const patField = h("div", { class: "custom-rule-form__field" });
    const patLbl = h("label", { for: "rule-param-pattern" });
    patLbl.textContent = "Glob Pattern";
    const patInp = h("input", {
      type: "text",
      id: "rule-param-pattern",
      class: "input-text",
      value: initial.pattern || "src/**/*.ts",
      placeholder: "e.g. src/**/*.ts or docs/**/*.md",
    });
    patField.appendChild(patLbl);
    patField.appendChild(patInp);
    container.appendChild(patField);

    const row = h("div", { class: "custom-rule-form__row", style: "margin-top:0.4rem;" });
    const minField = h("div", { class: "custom-rule-form__field" });
    const minLbl = h("label", { for: "rule-param-min" });
    minLbl.textContent = "Minimum Count (optional)";
    const minInp = h("input", {
      type: "number",
      id: "rule-param-min",
      class: "input-text",
      min: "0",
      value: initial.min !== undefined ? String(initial.min) : "",
      placeholder: "e.g. 1",
    });
    minField.appendChild(minLbl);
    minField.appendChild(minInp);

    const maxField = h("div", { class: "custom-rule-form__field" });
    const maxLbl = h("label", { for: "rule-param-max" });
    maxLbl.textContent = "Maximum Count (optional)";
    const maxInp = h("input", {
      type: "number",
      id: "rule-param-max",
      class: "input-text",
      min: "0",
      value: initial.max !== undefined ? String(initial.max) : "",
      placeholder: "e.g. 100",
    });
    maxField.appendChild(maxLbl);
    maxField.appendChild(maxInp);

    row.appendChild(minField);
    row.appendChild(maxField);
    container.appendChild(row);
  } else if (type === "json_field_equals") {
    const row = h("div", { class: "custom-rule-form__row" });
    const pathField = h("div", { class: "custom-rule-form__field" });
    const pathLbl = h("label", { for: "rule-param-path" });
    pathLbl.textContent = "JSON File Path";
    const pathInp = h("input", {
      type: "text",
      id: "rule-param-path",
      class: "input-text",
      value: initial.path || "package.json",
      placeholder: "e.g. package.json",
    });
    pathField.appendChild(pathLbl);
    pathField.appendChild(pathInp);

    const fieldField = h("div", { class: "custom-rule-form__field" });
    const fieldLbl = h("label", { for: "rule-param-field" });
    fieldLbl.textContent = "JSON Field (Dot Notation)";
    const fieldInp = h("input", {
      type: "text",
      id: "rule-param-field",
      class: "input-text",
      value: initial.field || "license",
      placeholder: "e.g. license or scripts.test",
    });
    fieldField.appendChild(fieldLbl);
    fieldField.appendChild(fieldInp);

    row.appendChild(pathField);
    row.appendChild(fieldField);
    container.appendChild(row);

    const expField = h("div", { class: "custom-rule-form__field", style: "margin-top:0.4rem;" });
    const expLbl = h("label", { for: "rule-param-expected" });
    expLbl.textContent = "Expected Value (Text, Number, or Boolean)";
    const expInp = h("input", {
      type: "text",
      id: "rule-param-expected",
      class: "input-text",
      value: initial.expectedValue !== undefined ? String(initial.expectedValue) : "MIT",
      placeholder: "e.g. MIT, true, or 18",
    });
    expField.appendChild(expLbl);
    expField.appendChild(expInp);
    container.appendChild(expField);
  }
}

export function initCustomRulesPanel() {
  const panel = qs("#custom-rules-panel");
  const toggleBtn = qs("#custom-rules-toggle-btn");
  const panelBody = qs("#custom-rules-panel-body");
  const countBadge = qs("#custom-rules-count-badge");
  const listEl = qs("#custom-rules-list");
  const formEl = qs("#custom-rule-form");
  const formTitle = qs("#rule-form-title");
  const errorEl = qs("#custom-rule-error");

  const inputId = qs("#rule-input-id");
  const inputName = qs("#rule-input-name");
  const inputDesc = qs("#rule-input-desc");
  const inputType = qs("#rule-input-type");
  const inputWeight = qs("#rule-input-weight");
  const paramsContainer = qs("#custom-rule-params-container");

  const btnAddNew = qs("#rule-add-new-btn");
  const btnSave = qs("#rule-save-btn");
  const btnCancel = qs("#rule-cancel-btn");
  const btnExport = qs("#rule-export-btn");
  const btnImport = qs("#rule-import-btn");
  const fileImport = qs("#rule-import-file");
  const btnReset = qs("#rule-reset-btn");

  if (!panel || !toggleBtn || !panelBody) return;

  let currentRules = loadCustomRules();
  let editingRuleId = null;

  // Toggle accordion
  toggleBtn.addEventListener("click", () => {
    const isExpanded = toggleBtn.getAttribute("aria-expanded") === "true";
    toggleBtn.setAttribute("aria-expanded", String(!isExpanded));
    panelBody.style.display = isExpanded ? "none" : "";
    setClass(toggleBtn, "is-expanded", !isExpanded);
  });

  toggleBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleBtn.click();
    }
  });

  function renderList() {
    if (!listEl) return;
    listEl.textContent = "";

    if (countBadge) {
      countBadge.textContent = `${currentRules.length} rule${currentRules.length === 1 ? "" : "s"}`;
    }

    if (currentRules.length === 0) {
      const empty = h("p", { style: "font-size:12px; color:var(--c-text-tertiary); padding:0.5rem;" });
      empty.textContent = "No custom rules defined. Click '+ Add Rule' or 'Reset Defaults' to get started.";
      listEl.appendChild(empty);
      return;
    }

    for (const rule of currentRules) {
      const item = h("div", { class: "custom-rule-item", role: "listitem" });

      const info = h("div", { class: "custom-rule-item__info" });
      const nameLine = h("div", { class: "custom-rule-item__name" });

      const nameText = h("span");
      nameText.textContent = rule.name || rule.id;
      nameLine.appendChild(nameText);

      const typeBadge = h("span", { class: "custom-rule-item__type" });
      typeBadge.textContent = rule.type;
      nameLine.appendChild(typeBadge);

      info.appendChild(nameLine);

      const detailsLine = h("div", { class: "custom-rule-item__details" });
      detailsLine.textContent = `[${rule.id}] ${getRuleSummaryDetails(rule)}`;
      info.appendChild(detailsLine);

      item.appendChild(info);

      const actions = h("div", { class: "custom-rule-item__actions" });

      const editBtn = h("button", {
        type: "button",
        class: "btn-icon",
        title: "Edit rule",
        "aria-label": `Edit rule ${rule.id}`,
      });
      const editSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      editSvg.setAttribute("width", "13");
      editSvg.setAttribute("height", "13");
      editSvg.setAttribute("viewBox", "0 0 24 24");
      editSvg.setAttribute("fill", "none");
      editSvg.setAttribute("stroke", "currentColor");
      editSvg.setAttribute("stroke-width", "2");
      editSvg.setAttribute("stroke-linecap", "round");
      editSvg.setAttribute("stroke-linejoin", "round");
      const pathPencil = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pathPencil.setAttribute("d", "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7");
      const pathPencil2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pathPencil2.setAttribute("d", "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z");
      editSvg.appendChild(pathPencil);
      editSvg.appendChild(pathPencil2);
      editBtn.appendChild(editSvg);

      editBtn.addEventListener("click", () => {
        openEditForm(rule);
      });
      actions.appendChild(editBtn);

      const deleteBtn = h("button", {
        type: "button",
        class: "btn-icon btn-icon--delete",
        title: "Delete rule",
        "aria-label": `Delete rule ${rule.id}`,
      });
      const delSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      delSvg.setAttribute("width", "13");
      delSvg.setAttribute("height", "13");
      delSvg.setAttribute("viewBox", "0 0 24 24");
      delSvg.setAttribute("fill", "none");
      delSvg.setAttribute("stroke", "currentColor");
      delSvg.setAttribute("stroke-width", "2");
      delSvg.setAttribute("stroke-linecap", "round");
      delSvg.setAttribute("stroke-linejoin", "round");
      const delLine1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
      delLine1.setAttribute("x1", "18"); delLine1.setAttribute("y1", "6");
      delLine1.setAttribute("x2", "6");  delLine1.setAttribute("y2", "18");
      const delLine2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
      delLine2.setAttribute("x1", "6");  delLine2.setAttribute("y1", "6");
      delLine2.setAttribute("x2", "18"); delLine2.setAttribute("y2", "18");
      delSvg.appendChild(delLine1);
      delSvg.appendChild(delLine2);
      deleteBtn.appendChild(delSvg);

      deleteBtn.addEventListener("click", () => {
        currentRules = currentRules.filter((r) => r.id !== rule.id);
        saveCustomRules(currentRules);
        renderList();
        announceStatus(`Deleted rule ${rule.id}`);
      });
      actions.appendChild(deleteBtn);

      item.appendChild(actions);
      listEl.appendChild(item);
    }
  }

  function openCreateForm() {
    editingRuleId = null;
    if (formTitle) formTitle.textContent = "Add Custom Rule";
    if (inputId) {
      inputId.value = `custom.rule_${Date.now().toString().slice(-4)}`;
      inputId.disabled = false;
    }
    if (inputName) inputName.value = "";
    if (inputDesc) inputDesc.value = "";
    if (inputType) inputType.value = "file_exists";
    if (inputWeight) inputWeight.value = "1";
    if (errorEl) errorEl.style.display = "none";
    if (paramsContainer) renderRuleParamsForm(paramsContainer, "file_exists");
    if (formEl) formEl.style.display = "";
    inputId?.focus();
  }

  function openEditForm(rule) {
    editingRuleId = rule.id;
    if (formTitle) formTitle.textContent = "Edit Custom Rule";
    if (inputId) {
      inputId.value = rule.id;
      inputId.disabled = true;
    }
    if (inputName) inputName.value = rule.name || "";
    if (inputDesc) inputDesc.value = rule.description || "";
    if (inputType) inputType.value = rule.type;
    if (inputWeight) inputWeight.value = String(rule.weight ?? 1);
    if (errorEl) errorEl.style.display = "none";
    if (paramsContainer) renderRuleParamsForm(paramsContainer, rule.type, rule);
    if (formEl) formEl.style.display = "";
    inputName?.focus();
  }

  function closeForm() {
    editingRuleId = null;
    if (formEl) formEl.style.display = "none";
    if (errorEl) errorEl.style.display = "none";
  }

  inputType?.addEventListener("change", () => {
    if (paramsContainer) renderRuleParamsForm(paramsContainer, inputType.value);
  });

  btnAddNew?.addEventListener("click", openCreateForm);
  btnCancel?.addEventListener("click", closeForm);

  btnSave?.addEventListener("click", () => {
    const id = inputId?.value?.trim() || "";
    const name = inputName?.value?.trim() || "";
    const description = inputDesc?.value?.trim() || undefined;
    const type = inputType?.value || "file_exists";
    const weight = parseInt(inputWeight?.value || "1", 10) || 1;

    if (!id) {
      showRuleError("Rule ID is required (e.g. custom.my_rule).");
      return;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
      showRuleError("Rule ID may only contain letters, numbers, dots, hyphens, and underscores.");
      return;
    }
    if (!name) {
      showRuleError("Rule Name is required.");
      return;
    }

    if (editingRuleId === null && currentRules.some((r) => r.id === id)) {
      showRuleError(`A rule with ID '${id}' already exists.`);
      return;
    }

    const newRule = { id, name, type, weight };
    if (description) newRule.description = description;

    if (type === "file_exists" || type === "file_missing") {
      const p = qs("#rule-param-path")?.value?.trim();
      if (!p) {
        showRuleError("File path is required.");
        return;
      }
      newRule.path = p;
    } else if (type === "file_contains") {
      const p = qs("#rule-param-path")?.value?.trim();
      const pat = qs("#rule-param-pattern")?.value?.trim();
      const isRegex = qs("#rule-param-is-regex")?.checked || false;
      if (!p) {
        showRuleError("File path is required.");
        return;
      }
      if (!pat) {
        showRuleError("Pattern to match is required.");
        return;
      }
      if (isRegex) {
        try {
          new RegExp(pat);
        } catch (e) {
          showRuleError(`Invalid regular expression: ${e.message}`);
          return;
        }
      }
      newRule.path = p;
      newRule.pattern = pat;
      if (isRegex) newRule.isRegex = true;
    } else if (type === "file_count") {
      const pat = qs("#rule-param-pattern")?.value?.trim();
      const minVal = qs("#rule-param-min")?.value?.trim();
      const maxVal = qs("#rule-param-max")?.value?.trim();
      if (!pat) {
        showRuleError("Glob pattern is required.");
        return;
      }
      if ((minVal === "" || minVal === undefined) && (maxVal === "" || maxVal === undefined)) {
        showRuleError("At least one of Min Count or Max Count must be specified.");
        return;
      }
      newRule.pattern = pat;
      if (minVal !== "" && minVal !== undefined) newRule.min = parseInt(minVal, 10);
      if (maxVal !== "" && maxVal !== undefined) newRule.max = parseInt(maxVal, 10);
    } else if (type === "json_field_equals") {
      const p = qs("#rule-param-path")?.value?.trim();
      const f = qs("#rule-param-field")?.value?.trim();
      const exp = qs("#rule-param-expected")?.value?.trim();
      if (!p) {
        showRuleError("JSON file path is required.");
        return;
      }
      if (!f) {
        showRuleError("JSON field path is required.");
        return;
      }
      if (exp === undefined || exp === "") {
        showRuleError("Expected value is required.");
        return;
      }
      newRule.path = p;
      newRule.field = f;
      if (exp === "true") newRule.expectedValue = true;
      else if (exp === "false") newRule.expectedValue = false;
      else if (!isNaN(Number(exp)) && exp !== "") newRule.expectedValue = Number(exp);
      else newRule.expectedValue = exp;
    }

    if (editingRuleId !== null) {
      currentRules = currentRules.map((r) => (r.id === editingRuleId ? newRule : r));
    } else {
      currentRules.push(newRule);
    }

    saveCustomRules(currentRules);
    renderList();
    closeForm();
    announceStatus(`Saved rule ${newRule.id}`);
  });

  function showRuleError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.style.display = "";
  }

  // Export JSON
  btnExport?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(currentRules, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "rules.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    announceStatus("Exported rules.json");
  });

  // Import JSON
  btnImport?.addEventListener("click", () => {
    fileImport?.click();
  });

  fileImport?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target.result);
        if (!Array.isArray(parsed)) {
          alert("Import failed: JSON file must contain an array of rules.");
          return;
        }
        const validRules = [];
        for (const r of parsed) {
          if (r && typeof r === "object" && typeof r.id === "string" && typeof r.type === "string") {
            validRules.push(r);
          }
        }
        if (validRules.length === 0) {
          alert("Import failed: No valid rules found in JSON file.");
          return;
        }
        currentRules = validRules;
        saveCustomRules(currentRules);
        renderList();
        announceStatus(`Imported ${validRules.length} rules.`);
      } catch (err) {
        alert("Import failed: Invalid JSON format.");
      } finally {
        fileImport.value = "";
      }
    };
    reader.readAsText(file);
  });

  // Reset Defaults
  btnReset?.addEventListener("click", () => {
    if (confirm("Reset custom rules to default templates?")) {
      currentRules = [...DEFAULT_CUSTOM_RULES];
      saveCustomRules(currentRules);
      renderList();
      closeForm();
      announceStatus("Reset custom rules to defaults.");
    }
  });

  // Initial render
  renderList();
}

// ============================================================
// § INPUT PANEL & SAMPLE LINKS
// ============================================================

export function initInputPanel() {
  const form       = qs("#judge-form");
  const urlInput   = qs("#repo-url");
  const feedback   = qs("#url-feedback");
  const analyzeBtn = qs("#analyze-btn");
  const modeInputs = qsa("input[name='mode']");

  if (!form || !urlInput) return;

  // Sample buttons
  const sampleBtns = qsa("[data-sample]");
  for (const btn of sampleBtns) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sample;
      if (SAMPLES[key]) {
        urlInput.value = SAMPLES[key].url;
        clearFeedback();
        urlInput.focus();
      }
    });
  }

  // Inline URL validation on blur/input
  urlInput.addEventListener("input", () => {
    if (urlInput.value.trim() === "") {
      clearFeedback();
      return;
    }
    const { ok, message } = validateUrl(urlInput.value);
    if (!ok) {
      showFeedback(message, false);
    } else {
      showFeedback("Looks good!", true);
    }
  });

  urlInput.addEventListener("blur", () => {
    if (urlInput.value.trim() === "") {
      clearFeedback();
    }
  });

  // Form submit
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (getState() === "loading") return;

    const rawUrl = urlInput.value.trim();
    const { ok, message } = validateUrl(rawUrl);
    if (!ok) {
      showFeedback(message, false);
      urlInput.setAttribute("aria-invalid", "true");
      urlInput.focus();
      return;
    }

    clearFeedback();
    urlInput.setAttribute("aria-invalid", "false");

    const selectedMode = modeInputs.find((r) => r.checked)?.value ?? "rules";
    _currentMode = selectedMode;
    updateNavMode(_currentMode);

    if (_currentAbortController) {
      _currentAbortController.abort();
    }
    _currentAbortController = new AbortController();
    const signal = _currentAbortController.signal;

    if (analyzeBtn) analyzeBtn.disabled = true;
    setState("loading");

    const clientTimeout = setTimeout(() => {
      _currentAbortController?.abort();
    }, CLIENT_TIMEOUT_MS);

    const userApiKey = qs("#user-api-key")?.value?.trim();

    try {
      const customRules = loadCustomRules();
      const { scorecard, dataSource } = await fetchJudge(rawUrl, selectedMode, signal, userApiKey, customRules);
      clearTimeout(clientTimeout);

      _lastScorecard = scorecard;
      setState("success");
      renderResults(scorecard, dataSource);
      initCardTilt();
    } catch (err) {
      clearTimeout(clientTimeout);

      if (err.name === "AbortError") {
        showError("Request was cancelled or timed out. Please retry.");
        return;
      }

      const msg = err.message ?? "Evaluation failed.";
      const retryAfter = err.retryAfter ?? null;
      showError(msg, retryAfter);
    } finally {
      if (analyzeBtn) analyzeBtn.disabled = false;
    }
  });

  function showFeedback(msg, isOk) {
    if (!feedback) return;
    feedback.textContent = msg;
    setClass(feedback, "is-error", !isOk);
    setClass(feedback, "is-ok", isOk);
  }

  function clearFeedback() {
    if (!feedback) return;
    feedback.textContent = "";
    setClass(feedback, "is-error", false);
    setClass(feedback, "is-ok", false);
    urlInput.setAttribute("aria-invalid", "false");
  }
}

// ============================================================
// § NAVIGATION & CONFIG
// ============================================================

export function initNav() {
  const menuBtn    = qs("#mobile-menu-btn");
  const mobilePanel = qs("#mobile-panel");
  const mobileLinks = qsa(".nav__mobile-link, #mobile-panel .nav__mobile-link");

  if (!menuBtn || !mobilePanel) return;

  function openMenu() {
    mobilePanel.classList.add("is-open");
    menuBtn.setAttribute("aria-expanded", "true");
  }

  function closeMenu() {
    mobilePanel.classList.remove("is-open");
    menuBtn.setAttribute("aria-expanded", "false");
  }

  menuBtn.addEventListener("click", () => {
    const isOpen = menuBtn.getAttribute("aria-expanded") === "true";
    if (isOpen) closeMenu(); else openMenu();
  });

  for (const link of mobileLinks) {
    link.addEventListener("click", closeMenu);
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
}

export function updateNavMode(mode) {
  const badge = qs("#nav-mode-badge");
  const text  = qs("#nav-mode-text");
  if (!badge || !text) return;
  const isAi = mode === "rules+ai" || mode === "rules+gemma";
  text.textContent = isAi ? "Rules + AI" : "Rules Only";
  setClass(badge, "is-rules", mode === "rules");
  setClass(badge, "is-gemma", isAi);
  setClass(badge, "is-ai", isAi);
}

export function initModeSelector() {
  const modeInputs = qsa("input[name='mode']");
  const gemmaStep  = qs("#loading-gemma-step");

  for (const radio of modeInputs) {
    radio.addEventListener("change", () => {
      _currentMode = radio.value;
      updateNavMode(_currentMode);
      if (gemmaStep) {
        const isAi = _currentMode === "rules+ai" || _currentMode === "rules+gemma";
        gemmaStep.style.display = isAi ? "" : "none";
      }
    });
  }

  // Arrow-key keyboard navigation for accessible radio group
  const modeGroup = qs(".mode-selector__group");
  if (modeGroup) {
    modeGroup.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const focused = document.activeElement;
      const all = qsa("input[name='mode']", modeGroup);
      const idx = all.indexOf(focused);
      if (idx === -1) return;
      const next = e.key === "ArrowRight"
        ? (idx + 1) % all.length
        : (idx - 1 + all.length) % all.length;
      all[next].focus();
      all[next].checked = true;
      all[next].dispatchEvent(new Event("change", { bubbles: true }));
      e.preventDefault();
    });
  }
}

export function initActiveLinks() {
  const links = qsa(".nav__link[href^='#']");
  const sections = links.map((l) => qs(l.getAttribute("href"))).filter(Boolean);

  if (!("IntersectionObserver" in window)) return;

  const obs = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute("id");
          for (const link of links) {
            setClass(link, "is-active", link.getAttribute("href") === `#${id}`);
          }
        }
      }
    },
    { rootMargin: "-40% 0px -55% 0px" }
  );

  for (const sec of sections) obs.observe(sec);
}

export function initResetButtons() {
  const analyzeAnotherBtn = qs("#analyze-another-btn");
  const errorResetBtn     = qs("#error-reset-btn");
  const retryBtn          = qs("#retry-btn");

  function resetToIdle() {
    setState("idle");
    const input = qs("#repo-url");
    if (input) {
      input.value = "";
      input.removeAttribute("aria-invalid");
      input.focus();
    }
  }

  if (analyzeAnotherBtn) {
    analyzeAnotherBtn.addEventListener("click", resetToIdle);
  }
  if (errorResetBtn) {
    errorResetBtn.addEventListener("click", resetToIdle);
  }
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      const form = qs("#judge-form");
      if (form) {
        setState("idle");
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    });
  }
}

export async function fetchConfig() {
  try {
    const resp = await fetch("/api/config");
    if (!resp.ok) return { repoUrl: null, aiAvailable: false, provider: null, model: null };
    const data = await resp.json();
    return {
      repoUrl:
        data && typeof data.repoUrl === "string" && data.repoUrl.startsWith("https://github.com/")
          ? data.repoUrl
          : null,
      aiAvailable: Boolean(data?.aiAvailable),
      provider: data?.provider ?? null,
      model: data?.model ?? null,
    };
  } catch {
    return { repoUrl: null, aiAvailable: false, provider: null, model: null };
  }
}

export async function applyConfig() {
  const config = await fetchConfig();
  const repoUrl = config.repoUrl;

  const links = [
    qs("#nav-github-link"),
    qs("#mobile-github-link"),
    qs("#footer-github-link"),
  ];

  for (const link of links) {
    if (!link) continue;
    if (repoUrl) {
      link.setAttribute("href", repoUrl);
      link.classList.remove("nav__github--disabled", "footer-link--disabled");
    } else {
      link.removeAttribute("href");
      link.classList.add(
        link.classList.contains("footer-link") ? "footer-link--disabled" : "nav__github--disabled"
      );
      const label = link.getAttribute("aria-label") ?? "";
      link.setAttribute("aria-label", label.replace("Open", "GitHub repository (link pending) —"));
    }
  }

  // Handle AI availability
  const aiRadio = qs("#mode-ai") || qs("#mode-gemma");
  const aiDisabledMsg = qs("#ai-disabled-msg");
  const userApiKeyInput = qs("#user-api-key");

  function refreshAIAvailability() {
    const hasCustomKey = Boolean(userApiKeyInput && userApiKeyInput.value.trim().length > 0);
    const isAvailable = config.aiAvailable || hasCustomKey;

    if (aiRadio) {
      if (!isAvailable) {
        aiRadio.disabled = true;
        if (aiRadio.checked) {
          const rulesRadio = qs("#mode-rules");
          if (rulesRadio) rulesRadio.checked = true;
        }
        if (aiDisabledMsg) aiDisabledMsg.style.display = "";
      } else {
        aiRadio.disabled = false;
        if (aiDisabledMsg) aiDisabledMsg.style.display = "none";
      }
    }
  }

  refreshAIAvailability();

  if (userApiKeyInput) {
    userApiKeyInput.addEventListener("input", refreshAIAvailability);
  }
}

// ============================================================
// § EFFECTS & VISUALIZATIONS
// ============================================================

let _orbitRunning = false;
let _orbitRafId = null;
let _orbitAngle = 0;
let _parallaxX = 0;
let _parallaxY = 0;
let _parallaxTargetX = 0;
let _parallaxTargetY = 0;

const ORBIT_NODES = [
  { ring: 0, speed: 0.4,  color: "#5ce1ff", size: 3, startAngle: 0   },
  { ring: 0, speed: 0.4,  color: "#7c5cff", size: 2, startAngle: 2.1 },
  { ring: 0, speed: 0.4,  color: "#9aa4c0", size: 2, startAngle: 4.2 },
  { ring: 1, speed: 0.25, color: "#5ce1ff", size: 4, startAngle: 1.0 },
  { ring: 1, speed: 0.25, color: "#7c5cff", size: 3, startAngle: 3.1 },
  { ring: 2, speed: 0.15, color: "#7c5cff", size: 5, startAngle: 0.5 },
  { ring: 2, speed: 0.15, color: "#5ce1ff", size: 3, startAngle: 3.6 },
];

const ORBIT_RADII = [80, 140, 210];

export function drawOrbit(canvas, ts) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2 + _parallaxX * 0.05;
  const cy = H / 2 + _parallaxY * 0.05;

  ctx.clearRect(0, 0, W, H);

  // Core — glowing hexagon
  const coreSize = 28;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(_orbitAngle * 0.3);

  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreSize * 2.5);
  grad.addColorStop(0, "rgba(124, 92, 255, 0.25)");
  grad.addColorStop(0.4, "rgba(92, 225, 255, 0.10)");
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, coreSize * 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(124, 92, 255, 0.6)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 6;
    const x = Math.cos(a) * coreSize;
    const y = Math.sin(a) * coreSize;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = "rgba(92, 225, 255, 0.9)";
  ctx.beginPath();
  ctx.arc(0, 0, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Orbit rings
  for (let i = 0; i < ORBIT_RADII.length; i++) {
    const r = ORBIT_RADII[i];
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255, ${0.04 - i * 0.01})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Orbiting nodes
  const tSec = ts / 1000;
  for (const node of ORBIT_NODES) {
    const r = ORBIT_RADII[node.ring];
    const angle = node.startAngle + tSec * node.speed + _orbitAngle;
    const nx = cx + Math.cos(angle) * r;
    const ny = cy + Math.sin(angle) * r;

    const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, node.size * 3);
    ng.addColorStop(0, node.color + "aa");
    ng.addColorStop(1, "transparent");
    ctx.fillStyle = ng;
    ctx.beginPath();
    ctx.arc(nx, ny, node.size * 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = node.color;
    ctx.beginPath();
    ctx.arc(nx, ny, node.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function startOrbit() {
  const canvas = qs("#orbit-canvas");
  if (!canvas || _orbitRunning) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  _orbitRunning = true;
  let lastTs = null;

  function frame(ts) {
    if (!_orbitRunning) return;
    if (lastTs !== null) {
      const dt = (ts - lastTs) / 1000;
      _orbitAngle += dt * 0.2;
      _parallaxX += (_parallaxTargetX - _parallaxX) * 0.08;
      _parallaxY += (_parallaxTargetY - _parallaxY) * 0.08;
    }
    lastTs = ts;
    drawOrbit(canvas, ts);
    _orbitRafId = requestAnimationFrame(frame);
  }

  _orbitRafId = requestAnimationFrame(frame);
}

export function stopOrbit() {
  _orbitRunning = false;
  if (_orbitRafId !== null) {
    cancelAnimationFrame(_orbitRafId);
    _orbitRafId = null;
  }
}

export function initHeroGlow() {
  const hero = qs("#hero");
  const glow = qs("#hero-glow");
  if (!hero || !glow) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let glowRafPending = false;
  hero.addEventListener("pointermove", (e) => {
    if (glowRafPending) return;
    glowRafPending = true;
    requestAnimationFrame(() => {
      const rect = hero.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      glow.style.transform = `translate(${x - 300}px, ${y - 300}px)`;

      _parallaxTargetX = (x - rect.width / 2) * 0.5;
      _parallaxTargetY = (y - rect.height / 2) * 0.5;
      glowRafPending = false;
    });
  }, { passive: true });
}

export function initMagneticButton() {
  const btn = qs("#analyze-btn");
  if (!btn) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (window.matchMedia("(pointer: coarse)").matches) return;

  const MAX_OFFSET = 6;
  let btnRafPending = false;

  btn.addEventListener("pointermove", (e) => {
    if (btnRafPending) return;
    btnRafPending = true;
    requestAnimationFrame(() => {
      const rect = btn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const radius = rect.width * 0.8;

      if (dist < radius) {
        const factor = (1 - dist / radius) * MAX_OFFSET;
        const ox = (dx / dist) * factor;
        const oy = (dy / dist) * factor;
        btn.style.transform = `translate(${ox}px, ${oy}px) translateY(-2px)`;
        const bx = ((e.clientX - rect.left) / rect.width) * 100;
        const by = ((e.clientY - rect.top) / rect.height) * 100;
        btn.style.setProperty("--btn-mx", `${bx}%`);
        btn.style.setProperty("--btn-my", `${by}%`);
      }
      btnRafPending = false;
    });
  }, { passive: true });

  btn.addEventListener("pointerleave", () => {
    btn.style.transform = "";
  }, { passive: true });
}

export function initCardTilt() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (window.matchMedia("(pointer: coarse)").matches) return;

  const MAX_TILT = 6;

  function handleTilt(e, card) {
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const rx = ((e.clientY - cy) / (rect.height / 2)) * -MAX_TILT;
    const ry = ((e.clientX - cx) / (rect.width / 2)) * MAX_TILT;
    card.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  }

  const grid = qs("#criteria-grid");
  if (!grid) return;

  grid.addEventListener("pointermove", (e) => {
    const card = e.target.closest(".criterion-card");
    if (!card) return;
    requestAnimationFrame(() => handleTilt(e, card));
  }, { passive: true });

  grid.addEventListener("pointerleave", (e) => {
    const card = e.target.closest?.(".criterion-card");
    if (card) card.style.transform = "";
  }, { passive: true });
}

let _revealObserver = null;
export function initReveal() {
  const items = qsa(".reveal");
  if (!("IntersectionObserver" in window)) {
    for (const el of items) setClass(el, "no-observer", true);
    return;
  }

  if (_revealObserver) _revealObserver.disconnect();
  _revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setClass(entry.target, "is-visible", true);
          _revealObserver.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 }
  );

  for (const el of items) _revealObserver.observe(el);
}

export function initVisibilityCleanup() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopOrbit();
    } else if (getState() === "idle") {
      startOrbit();
    }
  });
}

// ============================================================
// § TESTABILITY EXPORTS
// ============================================================
if (typeof globalThis !== "undefined") {
  globalThis.__rjExports = {
    h,
    validateUrl,
    isSafeExternalUrl,
    repoNameFromUrl,
    CRITERION_ORDER,
    buildCriterionCard,
    buildEvidencePanel,
    makeCheckOrXIcon,
    buildScoreRing,
    buildPlainTextSummary,
    renderResults,
    buildBadge,
    DEFAULT_CUSTOM_RULES,
    loadCustomRules,
    saveCustomRules,
    initCustomRulesPanel,
  };
}

// ============================================================
// § INIT
// ============================================================

function init() {
  setState("idle");
  initNav();
  initActiveLinks();
  initInputPanel();
  initCustomRulesPanel();
  initModeSelector();
  initResetButtons();
  initCopyButton();
  initHeroGlow();
  initMagneticButton();
  startOrbit();
  initReveal();
  initVisibilityCleanup();
  applyConfig();
  updateNavMode("rules");
}

if (typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
