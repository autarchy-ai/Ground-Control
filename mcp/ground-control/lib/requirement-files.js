// File-based requirement reader for the post-teardown MCP (issue #1500, ADR-093).
//
// Requirements are the record as repo-local files: docs/requirements/<UID>/requirement.md,
// with YAML frontmatter (id, title, status, type, priority, wave, timestamps) and a body
// carrying `## Statement`, an optional `## Rationale`, and an optional `## Traceability` list.
// There is no backend and no database; git is the source of truth. This module replaces the
// former `/api/v1/requirements/*` REST reads with direct filesystem reads, keeping the exact
// object shape the /implement workflow consumes (id, uid, title, statement, status, wave, and
// traceability links). The exporter (RequirementsMarkdownExportService) is the write contract;
// keep the two in step.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { EXACT_REQUIREMENT_UID_RE, execFile } from "./runtime-primitives.js";

const SPECS_SUBDIR = join("docs", "requirements");

// A full Git object id (sha1 = 40 hex, sha256 = 64 hex). The revision-scoped
// reader accepts only a full, server-resolved OID — never a branch name, HEAD, or
// an abbreviated hash — so completion can never validate a mutable ref (issue #1541).
const FULL_GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// `- <linkType> → <artifactType> `<artifactIdentifier>`` with an optional ` (<artifactTitle>)`.
const TRACE_LINE_RE = /^-\s+(\S+)\s+→\s+(\S+)\s+`([^`]+)`(?:\s+\((.+)\))?\s*$/;

function specDir(repoPath) {
  return join(repoPath, SPECS_SUBDIR);
}

const REQUIREMENT_FILENAME = "requirement.md";

function requirementPath(repoPath, uid) {
  return join(specDir(repoPath), uid, REQUIREMENT_FILENAME);
}

// Parse the leading `---` YAML frontmatter block into a flat map plus the body lines that follow.
// Only flat `key: value` scalars are read (the contract the exporter writes); quoted string
// values are unquoted. Returns null when the frontmatter is missing or unterminated.
function parse(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const frontmatter = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { frontmatter, body: lines.slice(i + 1) };
    }
    const sep = lines[i].indexOf(":");
    if (sep > 0) {
      const key = lines[i].slice(0, sep).trim();
      let value = lines[i].slice(sep + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
      frontmatter[key] = value;
    }
  }
  return null;
}

// Body text of a `## <heading>` section, up to the next `## ` heading or end of file.
function section(body, heading) {
  const start = body.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return null;
  const collected = [];
  for (let i = start + 1; i < body.length; i++) {
    if (body[i].startsWith("## ")) break;
    collected.push(body[i]);
  }
  return collected.join("\n").trim() || null;
}

function traceability(body) {
  const start = body.findIndex((line) => line.trim() === "## Traceability");
  if (start === -1) return [];
  const links = [];
  for (let i = start + 1; i < body.length; i++) {
    if (body[i].startsWith("## ")) break;
    const match = TRACE_LINE_RE.exec(body[i].trim());
    if (match) {
      links.push({
        linkType: match[1],
        artifactType: match[2],
        artifactIdentifier: match[3],
        artifactTitle: match[4] ?? null,
        artifactUrl: null,
      });
    }
  }
  return links;
}

function toRequirement(uid, parsed) {
  const fm = parsed.frontmatter;
  const waveRaw = fm.wave;
  const wave = waveRaw != null && waveRaw !== "" && !Number.isNaN(Number(waveRaw)) ? Number(waveRaw) : null;
  return {
    id: fm.id || uid,
    uid: fm.id || uid,
    title: fm.title || "",
    statement: section(parsed.body, "Statement") || "",
    rationale: section(parsed.body, "Rationale") || "",
    requirementType: fm.type || null,
    // Snake alias for consumers that read the former REST shape (e.g. formatIssueBody).
    requirement_type: fm.type || null,
    type: fm.type || null,
    priority: fm.priority || null,
    status: fm.status || null,
    wave,
    createdAt: fm.created_at || null,
    updatedAt: fm.updated_at || null,
    traceabilityLinks: traceability(parsed.body),
  };
}

// Read one requirement by UID. Returns null when the file is absent or malformed.
export async function readRequirementByUid(repoPath, uid) {
  let text;
  try {
    text = await fs.readFile(requirementPath(repoPath, uid), "utf8");
  } catch {
    return null;
  }
  const parsed = parse(text);
  return parsed ? toRequirement(uid, parsed) : null;
}

export async function readTraceabilityLinks(repoPath, uid) {
  const requirement = await readRequirementByUid(repoPath, uid);
  return requirement ? requirement.traceabilityLinks : [];
}

// Repo-root-relative POSIX path for a requirement file, for use as a Git pathspec.
// Git addresses tree entries with forward slashes on every platform, so this is
// deliberately a plain template string rather than path.join()/path.sep.
function requirementGitPath(uid) {
  return `docs/requirements/${uid}/requirement.md`;
}

// Read one requirement from an IMMUTABLE Git revision (a full commit object id),
// never the working tree. The post-merge completion assertion uses this to verify
// requirement state at the merged tree without checking anything out (issue #1541),
// so a final report can never claim a lifecycle state that is absent from the
// authoritative target branch.
//
// Returns a discriminated result so the caller can fail closed on each distinct
// condition WITHOUT surfacing requirement bodies or raw Git output:
//   { found: false }                  — bad UID/revision, or path absent at the revision
//   { found: true, malformed: true }  — file present but frontmatter missing/unterminated
//   { found: true, malformed: false, frontmatterId, requirement }
// `frontmatterId` is the RAW frontmatter `id:` (null when absent). It deliberately
// does NOT apply readRequirementByUid's `id || uid` fallback, so a missing or
// mismatched frontmatter id cannot be hidden on the verification path.
export async function readRequirementAtRevision(repoPath, uid, revision) {
  if (typeof uid !== "string" || !EXACT_REQUIREMENT_UID_RE.test(uid)) {
    return { found: false, malformed: false };
  }
  if (typeof revision !== "string" || !FULL_GIT_OID_RE.test(revision)) {
    return { found: false, malformed: false };
  }
  let text;
  try {
    // Fixed argv, no shell: `git show <revision>:<path>`. execFile does not spawn a
    // shell, so the revision and path are literal arguments (no interpolation risk).
    ({ stdout: text } = await execFile(
      "git",
      ["show", `${revision}:${requirementGitPath(uid)}`],
      { cwd: repoPath },
    ));
  } catch {
    // Absent path at the revision, or an object not present locally: fail closed and
    // let the caller report a bounded reason. Git's stderr is intentionally dropped.
    return { found: false, malformed: false };
  }
  const parsed = parse(text);
  if (!parsed) return { found: true, malformed: true };
  return {
    found: true,
    malformed: false,
    frontmatterId: parsed.frontmatter.id ?? null,
    requirement: toRequirement(uid, parsed),
  };
}

// Resolve the canonical path of the file a descriptor ACTUALLY holds.
//
// Validating the pathname after opening it is racy: an attacker who can mutate the
// checkout points the UID path outside the repository while `open` runs, then restores
// the in-repository file before the check, so containment passes while the open handle
// still refers to the external file — and this privileged process publishes its title.
// /proc/self/fd names the descriptor's own file and cannot be re-pointed after the open.
//
// There is deliberately NO pathname fallback. Resolving the pathname is precisely the
// race this closes, so offering it where /proc is absent would reopen the hole on those
// hosts instead of reporting that the check cannot be made. Callers fail closed instead.
export async function canonicalPathOfOpenFile(handle) {
  return fs.realpath(`/proc/self/fd/${handle.fd}`);
}

// Strict working-tree identity for a WRITE gate (issue #1569).
//
// readRequirementByUid above applies an `id || uid` compatibility fallback, so a file
// with a missing or mismatched frontmatter `id` reads back as if it were fine. That is
// tolerable for a read; it is not tolerable when the UID is about to be written into an
// issue's authoritative scope section. This returns the RAW frontmatter id so the caller
// can require `id === directory UID`, and refuses anything that is not a regular file at
// the exact UID path (lstat, so a symlink out of the requirements tree is not a
// requirement).
//
//   { found: false }                  — bad UID, absent path, or not a regular file
//   { found: true, malformed: true }  — frontmatter missing or unterminated
//   { found: true, malformed: false, frontmatterId, requirement }
export async function readRequirementIdentity(repoPath, uid) {
  if (typeof uid !== "string" || !EXACT_REQUIREMENT_UID_RE.test(uid)) {
    return { found: false, malformed: false };
  }
  const path = requirementPath(repoPath, uid);
  // A lexical prefix check, or an lstat of the leaf alone, only rejects a symlinked
  // `requirement.md`; `docs`, `requirements`, or the UID directory could still be links
  // to another checkout, and this privileged process would read that file and publish
  // its title into a GitHub issue body. Canonicalize both sides, require the resolved
  // candidate to be exactly the file inside the canonical UID directory, and read
  // through the handle that was opened and validated rather than re-opening by path.
  let handle;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return { found: false, malformed: false };
  }
  let text;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { found: false, malformed: false };
    let canonicalPath;
    try {
      canonicalPath = await canonicalPathOfOpenFile(handle);
    } catch {
      // Descriptor canonicalization is unavailable on this host, so containment cannot
      // be established at all. Reported distinctly: this is "cannot verify", not
      // "requirement absent", and the caller refuses rather than proceeding.
      return { found: false, malformed: false, unverifiable: true };
    }
    // Anchor containment to the canonical REPOSITORY root, never to a canonicalized
    // `docs/requirements`: canonicalizing the requirements directory itself lets that
    // directory become an external trust root, so replacing `docs` or `docs/requirements`
    // with a link to another host-readable checkout would resolve both sides outside this
    // repository and still compare equal. This privileged process would then publish that
    // checkout's requirement title into the destination issue.
    const canonicalRoot = await fs.realpath(repoPath);
    if (canonicalPath !== join(canonicalRoot, SPECS_SUBDIR, uid, REQUIREMENT_FILENAME)) {
      return { found: false, malformed: false };
    }
    text = await handle.readFile("utf8");
  } catch {
    return { found: false, malformed: false };
  } finally {
    await handle.close();
  }
  const parsed = parse(text);
  if (!parsed) return { found: true, malformed: true };
  return {
    found: true,
    malformed: false,
    frontmatterId: parsed.frontmatter.id ?? null,
    requirement: toRequirement(uid, parsed),
  };
}

// Read every requirement in the repo (one pass over docs/requirements/*/requirement.md).
export async function readAllRequirements(repoPath) {
  let entries;
  try {
    entries = await fs.readdir(specDir(repoPath), { withFileTypes: true });
  } catch {
    return [];
  }
  const requirements = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const requirement = await readRequirementByUid(repoPath, entry.name);
    if (requirement) requirements.push(requirement);
  }
  return requirements;
}

// Reverse lookup: every (requirement, link) whose link targets the given artifact — the
// file-based replacement for GET /api/v1/traceability?artifactType=…&artifactIdentifier=…
export async function findTraceabilityByArtifact(repoPath, artifactType, artifactIdentifier) {
  const wanted = String(artifactIdentifier);
  const matches = [];
  for (const requirement of await readAllRequirements(repoPath)) {
    for (const link of requirement.traceabilityLinks) {
      if (link.artifactType === artifactType && String(link.artifactIdentifier) === wanted) {
        matches.push({ ...link, requirementUid: requirement.uid, requirementId: requirement.id });
      }
    }
  }
  return matches;
}
