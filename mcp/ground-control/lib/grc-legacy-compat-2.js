// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { FINDING_BODY_MAX, FINDING_CATEGORY_SHAPE_MAX, FINDING_CLASSIFICATIONS, FINDING_CLASSIFICATION_NOTE_MAX, FINDING_SWEEP_EVIDENCE_MAX, FINDING_TITLE_MAX, getDefaultCodexReviewMaxDiffBytes, truncateReviewProse, validateFindingPath } from "./grc-legacy-compat.js";

export function validateFinding(raw, idx, repoRoot) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`finding at index ${idx} must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
  }
  let path;
  try {
    path = validateFindingPath(raw.path, repoRoot);
  } catch (err) {
    throw new Error(`finding at index ${idx}: ${err.message}`);
  }
  if (!("line" in raw)) {
    throw new Error(`finding at index ${idx} is missing required field 'line'`);
  }
  // line: null was originally documented as "file-level comment", but the
  // poster only omits `line` from the request — GitHub's API for file-level
  // review comments needs `subject_type=file`, which we don't yet send. Until
  // that posting path is implemented properly, reject null lines so codex
  // never emits findings the poster cannot post (closes a gap flagged in
  // #793 review cycle 1).
  if (!Number.isInteger(raw.line) || raw.line <= 0) {
    throw new Error(
      `finding at index ${idx} has invalid 'line' (must be a positive integer; file-level comments are not yet supported, got ${JSON.stringify(raw.line)})`,
    );
  }
  const line = raw.line;
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new Error(`finding at index ${idx} is missing required field 'title' (must be a non-empty string)`);
  }
  if (typeof raw.body !== "string" || raw.body.trim() === "") {
    throw new Error(`finding at index ${idx} is missing required field 'body' (must be a non-empty string)`);
  }
  // classification (#830): every finding declares whether it is a one-off or
  // one instance of a recurring category, so the agent designs the fix at the
  // category level rather than whack-a-mole'ing the reviewer-named site only.
  if (raw.classification === undefined || raw.classification === null) {
    throw new Error(
      `finding at index ${idx} is missing required field 'classification' (must be "one-off" or "class")`,
    );
  }
  if (!FINDING_CLASSIFICATIONS.has(raw.classification)) {
    throw new Error(
      `finding at index ${idx} has invalid 'classification' (must be "one-off" or "class", got ${JSON.stringify(raw.classification)})`,
    );
  }
  let category = null;
  if (raw.classification === "class") {
    if (raw.category === null || typeof raw.category !== "object" || Array.isArray(raw.category)) {
      throw new Error(
        `finding at index ${idx} has classification "class" but is missing required object field 'category' ({shape, instances})`,
      );
    }
    if (typeof raw.category.shape !== "string" || raw.category.shape.trim() === "") {
      throw new Error(
        `finding at index ${idx} 'category.shape' must be a non-empty string`,
      );
    }
    if (!Array.isArray(raw.category.instances) || raw.category.instances.length === 0) {
      throw new Error(
        `finding at index ${idx} 'category.instances' must be a non-empty array of "<path>:<line>" strings`,
      );
    }
    // Each instance must be a real "<path>:<line>" — same containment rules as
    // the finding's own `path` (no leading `/`, no `..` segments, inside the
    // repo) and a positive-integer line. Dedupe; the finding's own site must
    // appear so the category list is anchored to a concrete reviewed location.
    const seen = new Set();
    const normalized = [];
    for (const [j, inst] of raw.category.instances.entries()) {
      if (typeof inst !== "string" || inst.trim() === "") {
        throw new Error(
          `finding at index ${idx} 'category.instances[${j}]' must be a non-empty string`,
        );
      }
      const lastColon = inst.lastIndexOf(":");
      if (lastColon <= 0 || lastColon === inst.length - 1) {
        throw new Error(
          `finding at index ${idx} 'category.instances[${j}]' must be "<path>:<line>" (got ${JSON.stringify(inst)})`,
        );
      }
      const instPath = inst.slice(0, lastColon);
      const instLineStr = inst.slice(lastColon + 1);
      if (!/^\d+$/.test(instLineStr) || Number.parseInt(instLineStr, 10) <= 0) {
        throw new Error(
          `finding at index ${idx} 'category.instances[${j}]' must end with a positive-integer line (got ${JSON.stringify(inst)})`,
        );
      }
      let normPath;
      try {
        normPath = validateFindingPath(instPath, repoRoot);
      } catch (err) {
        throw new Error(`finding at index ${idx} 'category.instances[${j}]' path: ${err.message}`);
      }
      const normInst = `${normPath}:${Number.parseInt(instLineStr, 10)}`;
      if (!seen.has(normInst)) {
        seen.add(normInst);
        normalized.push(normInst);
      }
    }
    const ownSite = `${path}:${line}`;
    if (!seen.has(ownSite)) {
      throw new Error(
        `finding at index ${idx} 'category.instances' must include this finding's own site ${JSON.stringify(ownSite)}`,
      );
    }
    category = {
      shape: truncateReviewProse(raw.category.shape, FINDING_CATEGORY_SHAPE_MAX),
      instances: normalized,
    };
  } else if (raw.category !== undefined && raw.category !== null) {
    throw new Error(
      `finding at index ${idx} has classification "one-off" but also carries a 'category' — omit it (or set null) for one-off findings`,
    );
  }
  // sweep_evidence (#931): one-off findings must declare the sweep the reviewer
  // performed before concluding "no analogues elsewhere." LLM-authored bugs
  // routinely recur; an unswept one-off is the failure mode that lets a
  // category-level defect slip through review.
  let sweepEvidence = null;
  if (raw.classification === "one-off") {
    if (typeof raw.sweep_evidence !== "string" || raw.sweep_evidence.trim() === "") {
      throw new Error(
        `finding at index ${idx} has classification "one-off" but is missing required field 'sweep_evidence' (a one-line statement of what you grepped/scanned and what you did NOT find — see the prompt's sweep-evidence rule)`,
      );
    }
    sweepEvidence = truncateReviewProse(raw.sweep_evidence.trim(), FINDING_SWEEP_EVIDENCE_MAX);
  } else if (raw.sweep_evidence !== undefined && raw.sweep_evidence !== null) {
    // class findings carry their evidence in category.instances; sweep_evidence
    // is reserved for one-off so the two paths don't drift.
    throw new Error(
      `finding at index ${idx} has classification "class" but also carries a 'sweep_evidence' — class findings document instances via category.instances instead`,
    );
  }
  // structural_blocker (#931): optional opt-in flag a reviewer can set on a
  // one-off finding to indicate it is a structural blocker (e.g. a missing
  // security boundary at a unique site that nonetheless warrants don't-ship).
  // Class findings imply structural blocking by construction — do not double-
  // flag them with structural_blocker=true.
  let structuralBlocker = false;
  if (raw.structural_blocker !== undefined && raw.structural_blocker !== null) {
    if (typeof raw.structural_blocker !== "boolean") {
      throw new Error(`finding at index ${idx} 'structural_blocker' must be a boolean when set`);
    }
    if (raw.structural_blocker === true && raw.classification === "class") {
      throw new Error(
        `finding at index ${idx} has classification "class" so structural_blocker is implicit — set it only on one-off findings that warrant don't-ship`,
      );
    }
    structuralBlocker = raw.structural_blocker === true;
  }
  const finding = {
    path,
    line,
    title: truncateReviewProse(raw.title, FINDING_TITLE_MAX),
    body: truncateReviewProse(raw.body, FINDING_BODY_MAX),
    classification: raw.classification,
  };
  if (category !== null) finding.category = category;
  if (sweepEvidence !== null) finding.sweep_evidence = sweepEvidence;
  if (structuralBlocker) finding.structural_blocker = true;
  return finding;
}
export function formatFindingClassificationNote(finding) {
  if (finding.classification !== "class" || !finding.category) {
    return "";
  }
  const head = `_class finding — category: ${finding.category.shape}`;
  const tail = ". Fix the category, not just this site._\n\n";
  const instances = finding.category.instances || [];
  let listed = [];
  let listLen = 0;
  for (const inst of instances) {
    // " — instances: " (≈14) + joins; budget conservatively.
    const add = (listed.length === 0 ? 14 : 2) + inst.length;
    if (head.length + listLen + add + tail.length + 1 > FINDING_CLASSIFICATION_NOTE_MAX) {
      break;
    }
    listed.push(inst);
    listLen += add;
  }
  let note = head;
  if (listed.length > 0) {
    note += ` — instances: ${listed.join(", ")}`;
    if (listed.length < instances.length) {
      note += ", …";
    }
  }
  note += tail;
  if (note.length > FINDING_CLASSIFICATION_NOTE_MAX) {
    note = note.slice(0, FINDING_CLASSIFICATION_NOTE_MAX - 4) + "…_\n\n";
  }
  return note;
}
const PEM_BEGIN = "-----" + "BEGIN ";
const PEM_END = "-----";
const PEM_KEY_SUFFIX = "PRIVATE " + "KEY";
const SENSITIVE_BODY_PATTERNS = [
  { name: "private key", re: new RegExp(PEM_BEGIN + "[A-Z ]*" + PEM_KEY_SUFFIX + PEM_END) },
  { name: "ssh private key", re: new RegExp(PEM_BEGIN + "OPENSSH " + PEM_KEY_SUFFIX + PEM_END) },
  { name: "pgp private key", re: new RegExp(PEM_BEGIN + "PGP " + PEM_KEY_SUFFIX + " BLOCK" + PEM_END) },
  { name: "rsa private key", re: new RegExp(PEM_BEGIN + "RSA " + PEM_KEY_SUFFIX + PEM_END) },
  { name: "aws access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "google api key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "github personal access token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}\b/ },
  { name: "slack token", re: /\bxox[abp]-[0-9A-Za-z-]{10,}\b/ },
];
export function detectSensitiveBodyContent(body) {
  if (typeof body !== "string") return null;
  for (const { name, re } of SENSITIVE_BODY_PATTERNS) {
    if (re.test(body)) {
      return `body matched sensitive content pattern '${name}' — refusing to publish under host identity (issue #793 cycle 4 security control)`;
    }
  }
  return null;
}
export function extractGhErrorMessage(error) {
  // execFile rejects with an Error whose message includes the spawned command;
  // its `.stderr` carries the human-readable failure. Prefer stderr when it
  // exists so the returned envelope is actionable.
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr !== "") return stderr;
  return error?.message || String(error);
}
export function parseOwnerRepoFromRemoteUrl(url) {
  // Accepts the three URL shapes git remote emits:
  //   https://github.com/owner/name.git
  //   https://github.com/owner/name
  //   git@github.com:owner/name.git
  // Returns null when the URL is not a github.com remote — callers
  // decide whether that's fatal (most are; this MCP server is github-only).
  if (typeof url !== "string" || url.length === 0) return null;
  const trimmed = url.trim();
  // SSH form: git@github.com:owner/name(.git)?
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], name: sshMatch[2] };
  // HTTPS form: https://github.com/owner/name(.git)?(/)?
  const httpsMatch = trimmed.match(
    /^https?:\/\/(?:[^/@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (httpsMatch) return { owner: httpsMatch[1], name: httpsMatch[2] };
  return null;
}
export const EXECUTION_OBLIGATION_WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);
export const ENRICH_THREAD_PAGE_CAP = 100;
function reviewDiffBudget(maxBytes, promptOverheadBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return maxBytes;
  const overhead = Number.isSafeInteger(promptOverheadBytes) && promptOverheadBytes > 0
    ? promptOverheadBytes : 0;
  return Math.max(1, maxBytes - overhead);
}
export function selectDiffMode({ diffText, maxBytes = getDefaultCodexReviewMaxDiffBytes(), promptOverheadBytes = 0 }) {
  if (!maxBytes || maxBytes <= 0) return "inline";
  if (Buffer.byteLength(diffText || "", "utf8") > reviewDiffBudget(maxBytes, promptOverheadBytes)) return "manifest";
  return "inline";
}
const DIFF_FILE_HEADER_RE = /^diff --git /;
const DIFF_HUNK_HEADER_RE = /^@@ /;
const DIFF_FILE_HEADER_LINE_RE = /^diff --git .*$/gm;
function splitDiffBlocks(text, headerRe) {
  const blocks = [];
  let current = "";
  let index = 0;
  while (index < text.length) {
    let end = text.indexOf("\n", index);
    end = end === -1 ? text.length : end + 1;
    const line = text.slice(index, end);
    if (headerRe.test(line) && current !== "") {
      blocks.push(current);
      current = "";
    }
    current += line;
    index = end;
  }
  if (current !== "") blocks.push(current);
  return blocks;
}
function splitKeepingNewlines(text) {
  const lines = [];
  let index = 0;
  while (index < text.length) {
    let end = text.indexOf("\n", index);
    end = end === -1 ? text.length : end + 1;
    lines.push(text.slice(index, end));
    index = end;
  }
  return lines;
}
function sliceTextByLines(text, budget, prefix) {
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const slices = [];
  let current = "";
  let currentBytes = 0;
  for (const line of splitKeepingNewlines(text)) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (current !== "" && prefixBytes + currentBytes + lineBytes > budget) {
      slices.push(prefix + current);
      current = "";
      currentBytes = 0;
    }
    current += line;
    currentBytes += lineBytes;
  }
  if (current !== "") slices.push(prefix + current);
  return slices.length > 0 ? slices : [prefix + text];
}
const HUNK_RANGE_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
function sliceHunkWithRecomputedHeaders(fileHeader, hunk, budget) {
  const newlineAt = hunk.indexOf("\n");
  const headerLine = newlineAt === -1 ? hunk : hunk.slice(0, newlineAt);
  const body = newlineAt === -1 ? "" : hunk.slice(newlineAt + 1);
  const match = headerLine.match(HUNK_RANGE_RE);
  // An unparseable header cannot be recomputed; fall back to repeating it
  // verbatim rather than inventing coordinates.
  if (!match) return sliceTextByLines(body, budget, `${fileHeader}${headerLine}\n`);

  const trailing = match[5] ?? "";
  let oldStart = Number.parseInt(match[1], 10);
  let newStart = Number.parseInt(match[3], 10);

  const emit = (lines) => {
    let oldCount = 0;
    let newCount = 0;
    for (const line of lines) {
      const marker = line[0];
      if (marker === "+") newCount += 1;
      else if (marker === "-") oldCount += 1;
      else if (marker !== "\\") {
        oldCount += 1;
        newCount += 1;
      }
    }
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${trailing}\n`;
    oldStart += oldCount;
    newStart += newCount;
    return `${fileHeader}${header}${lines.join("")}`;
  };

  const fileHeaderBytes = Buffer.byteLength(fileHeader, "utf8");
  // Reserve worst-case room for a recomputed header so a fragment cannot
  // overflow the budget by the bytes the header itself adds.
  const headerBudget = Buffer.byteLength(`${headerLine}\n`, "utf8") + 40;
  const slices = [];
  let group = [];
  let groupBytes = 0;
  for (const line of splitKeepingNewlines(body)) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (group.length > 0 && fileHeaderBytes + headerBudget + groupBytes + lineBytes > budget) {
      slices.push(emit(group));
      group = [];
      groupBytes = 0;
    }
    group.push(line);
    groupBytes += lineBytes;
  }
  if (group.length > 0) slices.push(emit(group));
  return slices.length > 0 ? slices : [`${fileHeader}${headerLine}\n`];
}
function sliceFileBlockByHunks(block, budget) {
  const parts = splitDiffBlocks(block, DIFF_HUNK_HEADER_RE);
  const hasHunks = parts.length > 1 || DIFF_HUNK_HEADER_RE.test(parts[0] ?? "");
  if (!hasHunks) {
    // Metadata-only block (binary, rename, mode change). Repeat its
    // `diff --git` line on every fragment so a later fragment still says which
    // file it belongs to (issue #1414 codex cycle 2, F1).
    const newlineAt = block.indexOf("\n");
    if (newlineAt === -1) return [block];
    const attribution = block.slice(0, newlineAt + 1);
    return sliceTextByLines(block.slice(newlineAt + 1), budget, attribution);
  }

  const header = DIFF_HUNK_HEADER_RE.test(parts[0]) ? "" : parts[0];
  const hunks = header === "" ? parts : parts.slice(1);
  const headerBytes = Buffer.byteLength(header, "utf8");
  const slices = [];
  let current = "";
  let currentBytes = 0;
  const flush = () => {
    if (current !== "") {
      slices.push(header + current);
      current = "";
      currentBytes = 0;
    }
  };
  for (const hunk of hunks) {
    const hunkBytes = Buffer.byteLength(hunk, "utf8");
    // A hunk that cannot fit even alongside just the file header is split at
    // line boundaries, carrying the file header plus its own `@@` header into
    // every piece so each remains attributable.
    if (headerBytes + hunkBytes > budget) {
      flush();
      slices.push(...sliceHunkWithRecomputedHeaders(header, hunk, budget));
      continue;
    }
    if (current !== "" && headerBytes + currentBytes + hunkBytes > budget) flush();
    current += hunk;
    currentBytes += hunkBytes;
  }
  flush();
  return slices.length > 0 ? slices : [block];
}
function countDiffFiles(text) {
  DIFF_FILE_HEADER_LINE_RE.lastIndex = 0;
  const headers = new Set(text.match(DIFF_FILE_HEADER_LINE_RE) ?? []);
  return headers.size;
}
export function planReviewSlices({ diffText, maxBytes = getDefaultCodexReviewMaxDiffBytes(), promptOverheadBytes = 0 }) {
  const text = typeof diffText === "string" ? diffText : "";
  const filesTotal = countDiffFiles(text);
  // Same guard shape as selectDiffMode, so the two never disagree about
  // whether a diff is over budget.
  const budget = Number.isFinite(maxBytes) ? reviewDiffBudget(maxBytes, promptOverheadBytes) : 0;
  if (text === "" || budget <= 0 || Buffer.byteLength(text, "utf8") <= budget) {
    return {
      slices: [text],
      strategy: "whole-diff",
      files_total: filesTotal,
      files_covered: filesTotal,
      oversized_slices: 0,
    };
  }

  const slices = [];
  let current = "";
  // Tracked incrementally rather than re-measuring `current + block` each
  // iteration, which would be quadratic over a diff with many small files.
  let currentBytes = 0;
  let subFileSplit = false;
  const flush = () => {
    if (current !== "") {
      slices.push(current);
      current = "";
      currentBytes = 0;
    }
  };
  for (const block of splitDiffBlocks(text, DIFF_FILE_HEADER_RE)) {
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (blockBytes > budget) {
      flush();
      const inner = sliceFileBlockByHunks(block, budget);
      if (inner.length > 1) subFileSplit = true;
      slices.push(...inner);
      continue;
    }
    if (current !== "" && currentBytes + blockBytes > budget) flush();
    current += block;
    currentBytes += blockBytes;
  }
  flush();

  // A slice can still exceed the budget only when a single line does, which is
  // the smallest unit that survives splitting intact. Report the count so an
  // over-budget prompt is a visible fact rather than a silent one; never
  // truncate, because dropped bytes read as reviewed content that nobody saw.
  const oversized = slices.filter((s) => Buffer.byteLength(s, "utf8") > budget).length;

  return {
    slices,
    strategy: subFileSplit ? "hunk-slices" : "file-slices",
    files_total: filesTotal,
    files_covered: countDiffFiles(slices.join("")),
    oversized_slices: oversized,
  };
}
