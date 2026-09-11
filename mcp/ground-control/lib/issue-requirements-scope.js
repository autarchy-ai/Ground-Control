// The issue body's `## Requirements` section — one parser, one transformer (issue #1569).
//
// Four separate authorities derive a run's in-scope requirement UID set from this
// section: bootstrap, the requested_requirement_uid authorization gate, completion,
// and scope resolution. Until #1569 nothing could WRITE it for an issue that already
// existed, so a requirement introduced mid-run (Step 4's structural-gate rule) landed
// in a repository file no authority would read, and post-merge verification silently
// verified nothing.
//
// The reader and the writer live here together on purpose. A writer that reproduced
// the heading, boundary, bullet, wrapper, dedup, or UID-recognition rules would be a
// second parser, free to drift from the one the gates actually run.
//
// Extracted from lib/codex-workflow-2.js, which was at the 500-line limit
// (docs/CODING_STANDARDS.md, ADR-092). Behaviour of the reader is unchanged.

import { EXACT_REQUIREMENT_UID_RE, isRequirementUidToken } from "./runtime-primitives.js";

// These rewrite the lazy `\s+(.+?)\s*$` that reads as super-linear backtracking
// (Sonar S8786), each exactly equivalent because heading titles are trimmed and
// bullet tokens split on whitespace. Heading uses an unquantified `\s` before
// `(.+)`, removing the quantifier-vs-quantifier ambiguity while still matching a
// whitespace-only title (`##␠␠`) as the original did, so section breaks are
// unchanged. Bullet keeps `\s+` (it must eat every space after the marker) and
// anchors the capture at the first non-space `\S`; since `\s+` already consumed
// the whitespace, that changes nothing behaviorally.
const REQUIREMENTS_HEADING_RE = /^(#{1,6})\s(.+)$/;
const REQUIREMENTS_BULLET_RE = /^\s*[-*+]\s+(\S.*)$/;

const UID_TOKEN_LEADING_WRAPPERS = "`[(";
const UID_TOKEN_TRAILING_WRAPPERS = "`)].:";

const REQUIREMENTS_HEADING_TEXT = "## Requirements";
export const REQUIREMENT_SCOPE_OPERATIONS = Object.freeze(["add", "remove"]);

// Strip wrapping punctuation a UID token may carry in prose (backticks,
// brackets, parens, trailing sentence marks). A linear character scan; the
// equivalent `[...]+$` regex reads as super-linear to the analyzer (S8786).
function stripUidTokenWrappers(token) {
  let start = 0;
  let end = token.length;
  while (start < end && UID_TOKEN_LEADING_WRAPPERS.includes(token[start])) start += 1;
  while (end > start && UID_TOKEN_TRAILING_WRAPPERS.includes(token[end - 1])) end -= 1;
  return token.slice(start, end);
}

// Split into lines that remember their own terminator and source offsets, so a
// rebuilt region concatenates back to the original bytes. `body.split(/\r?\n/)`
// plus `join("\n")` would silently normalize CRLF endings and the trailing
// newline across the whole issue body, which is exactly what must not happen.
function splitLinesWithTerminators(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "\n") continue;
    const textEnd = i > start && text[i - 1] === "\r" ? i - 1 : i;
    lines.push({ text: text.slice(start, textEnd), term: text.slice(textEnd, i + 1) });
    start = i + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), term: "" });
  return lines;
}

function joinLines(lines) {
  return lines.map((line) => line.text + line.term).join("");
}

// Source offsets of the first parser-recognized level 2-4 `Requirements` section:
// where its content starts (just past the heading's terminator) and where it ends
// (at the next heading of the same or higher level). A later duplicate heading is
// deliberately outside the range — the extractor stops there too, so it is not a
// second scope authority.
export function locateRequirementsSection(issueBody) {
  if (typeof issueBody !== "string" || issueBody === "") return null;
  let level = null;
  let contentStart = 0;
  let offset = 0;
  for (const line of splitLinesWithTerminators(issueBody)) {
    const lineStart = offset;
    offset += line.text.length + line.term.length;
    const heading = REQUIREMENTS_HEADING_RE.exec(line.text);
    if (!heading) continue;
    const headingLevel = heading[1].length;
    if (level == null) {
      if (headingLevel >= 2 && headingLevel <= 4 && heading[2].trim().toLowerCase() === "requirements") {
        level = headingLevel;
        contentStart = offset;
      }
      continue;
    }
    if (headingLevel <= level) return { level, contentStart, contentEnd: lineStart };
  }
  if (level == null) return null;
  return { level, contentStart, contentEnd: issueBody.length };
}

function requirementsSectionLines(issueBody) {
  const found = locateRequirementsSection(issueBody);
  if (!found) return [];
  return splitLinesWithTerminators(issueBody.slice(found.contentStart, found.contentEnd))
    .map((line) => line.text);
}

// Read the leading run of UID tokens from one bullet line, stopping at the first
// token that is not a recognizable UID. Recognition, not identity validation:
// these tokens come from free-form issue prose, so the bounded-identifier
// contract would accept ordinary words. The anchored recognizer still finds
// allocator-minted short UIDs like APP-2, so a requirement-backed run is not
// silently reduced to a requirement-free one (issue #1425).
function requirementUidsFromBullet(line) {
  const bullet = REQUIREMENTS_BULLET_RE.exec(line);
  if (!bullet) return [];
  const uids = [];
  for (const token of bullet[1].split(/[\s,;]+/)) {
    const candidate = stripUidTokenWrappers(token);
    if (!isRequirementUidToken(candidate)) break;
    uids.push(candidate);
  }
  return uids;
}

export function extractInScopeRequirementUids(issueBody) {
  if (typeof issueBody !== "string" || issueBody === "") return [];
  const seen = new Set();
  const result = [];
  for (const line of requirementsSectionLines(issueBody)) {
    for (const candidate of requirementUidsFromBullet(line)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

// The title is untrusted input — it can carry newlines or a leading `- ` that
// would produce a second bullet and put an unrelated UID in scope. Collapsing
// whitespace runs keeps the bullet a single line, the same rule formatIssueBody
// applies when it seeds this section on the UID-first path.
export function renderRequirementBullet(uid, title) {
  const text = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  return text ? `- ${uid} — ${text}` : `- ${uid}`;
}

function dominantEol(body) {
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

function sectionAppendSeparator(body, eol) {
  if (body.length === 0) return "";
  if (!body.endsWith(eol)) return eol + eol;
  if (!body.endsWith(eol + eol)) return eol;
  return "";
}

function sameOrderedUids(left, right) {
  return left.length === right.length && left.every((uid, index) => uid === right[index]);
}

// Replace the section's scope-bearing bullets with one canonical bullet per UID.
// Every other line in the section — prose, checklists, blank lines — is carried
// through with its original terminator.
function rebuildSectionContent(content, bullets, eol) {
  const kept = [];
  let replaceAt = -1;
  for (const line of splitLinesWithTerminators(content)) {
    if (requirementUidsFromBullet(line.text).length > 0) {
      if (replaceAt === -1) replaceAt = kept.length;
      continue;
    }
    kept.push(line);
  }
  const block = bullets.map((text) => ({ text, term: eol }));
  if (block.length === 0) return joinLines(kept);
  if (replaceAt !== -1) {
    kept.splice(replaceAt, 0, ...block);
    return joinLines(kept);
  }
  // Nothing to replace: land the list after the section's prose, separated by a
  // blank line, and keep a blank line after it so the next section still reads
  // as a separate block.
  let start = 0;
  while (start < kept.length && kept[start].text.trim() === "") start += 1;
  let end = kept.length;
  while (end > start && kept[end - 1].text.trim() === "") end -= 1;
  const separator = end > start ? [{ text: "", term: eol }] : [];
  const trailing = end === kept.length ? [{ text: "", term: eol }] : [];
  kept.splice(end, 0, ...separator, ...block, ...trailing);
  return joinLines(kept);
}

function renderBodyWithScope(body, uids, titleByUid) {
  const eol = dominantEol(body);
  const bullets = uids.map((uid) => renderRequirementBullet(uid, titleByUid[uid]));
  const found = locateRequirementsSection(body);
  if (!found) {
    const rendered = bullets.map((bullet) => bullet + eol).join("");
    return `${body}${sectionAppendSeparator(body, eol)}${REQUIREMENTS_HEADING_TEXT}${eol}${eol}${rendered}`;
  }
  const content = rebuildSectionContent(
    body.slice(found.contentStart, found.contentEnd),
    bullets,
    eol,
  );
  // A body ending exactly at `## Requirements` has a recognized heading with no line
  // terminator, so `contentStart` sits at end-of-body. Concatenating generated content
  // straight onto it yields `## Requirements- GC-O007`, which the extractor cannot read
  // back — and since this is the only supported writer, that shape would have no
  // supported recovery. Supply the separator the heading line never got.
  const headingTerminated = body[found.contentStart - 1] === "\n";
  const separator = headingTerminated ? "" : eol + eol;
  return body.slice(0, found.contentStart) + separator + content + body.slice(found.contentEnd);
}

// Exported so a caller can reject a malformed operation before touching the
// filesystem or GitHub; resolveIntendedScope applies the same check.
export function validateRequirementScopeInput(operation, requirementUids) {
  if (!REQUIREMENT_SCOPE_OPERATIONS.includes(operation)) {
    return {
      ok: false,
      error: "issue_requirements_operation_invalid",
      message: "operation must be 'add' or 'remove'; there is no replace mode",
      next_action: "supply_add_or_remove_and_retry",
    };
  }
  if (
    !Array.isArray(requirementUids)
    || requirementUids.length === 0
    || !requirementUids.every((uid) => typeof uid === "string" && EXACT_REQUIREMENT_UID_RE.test(uid))
  ) {
    return {
      ok: false,
      error: "issue_requirements_uids_invalid",
      message: "requirement_uids must be a non-empty array of bounded requirement identifiers",
      next_action: "supply_at_least_one_valid_requirement_uid_and_retry",
    };
  }
  if (new Set(requirementUids).size !== requirementUids.length) {
    return {
      ok: false,
      error: "issue_requirements_uids_duplicated",
      message: "requirement_uids contains a duplicate entry",
      next_action: "supply_each_requirement_uid_once_and_retry",
    };
  }
  return null;
}

// The scope arithmetic, separated from rendering so the writer can resolve and
// validate the resulting UID set before it needs a title for each bullet. `add`
// unions onto the parsed current scope and can never remove a UID; `remove`
// subtracts only the named ones. There is deliberately no replace/set mode and an
// empty list is never permission to clear the section: routine use must not be able
// to silently narrow a run's scope.
export function resolveIntendedScope(issueBody, { operation, requirementUids } = {}) {
  const invalid = validateRequirementScopeInput(operation, requirementUids);
  if (invalid) return invalid;
  const body = typeof issueBody === "string" ? issueBody : "";
  const current = extractInScopeRequirementUids(body);
  const intended = operation === "add"
    ? [...current, ...requirementUids.filter((uid) => !current.includes(uid))]
    : current.filter((uid) => !requirementUids.includes(uid));
  // The no-op is decided from the parsed UID arrays, before canonicalization, so
  // re-adding the current set leaves an older-formatted section — and the body's
  // content hash — untouched rather than rewriting it for cosmetics.
  return { ok: true, current, intended, changed: !sameOrderedUids(current, intended) };
}

// Pure transformation: the resolved scope, rendered back into the section.
export function applyRequirementScopeOperation(
  issueBody,
  { operation, requirementUids, titleByUid = {} } = {},
) {
  const scope = resolveIntendedScope(issueBody, { operation, requirementUids });
  if (!scope.ok) return scope;

  const body = typeof issueBody === "string" ? issueBody : "";
  const { intended } = scope;
  if (!scope.changed) {
    return { ok: true, changed: false, body, requirementUids: scope.current };
  }

  const candidate = renderBodyWithScope(body, intended, titleByUid);
  // The executable round-trip invariant: what the writer produces must read back
  // through the extractor the gates run as exactly the intended ordered set.
  if (!sameOrderedUids(extractInScopeRequirementUids(candidate), intended)) {
    return {
      ok: false,
      error: "issue_requirements_round_trip_failed",
      message: "the rewritten Requirements section does not read back as the intended scope",
      next_action: "inspect_the_requirements_section_manually_and_retry",
    };
  }
  return { ok: true, changed: true, body: candidate, requirementUids: intended };
}
