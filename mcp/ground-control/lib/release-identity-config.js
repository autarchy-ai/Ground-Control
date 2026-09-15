// `release_families` configuration and identity rendering (issue #1579, ADR-097).
//
// A family's name becomes a Git reference segment and its rendered paths are returned to an agent
// that writes evidence there, so both are closed grammars rather than free text. The token grammar
// is the smallest one the first consumer needs: RAE's `retest-vN` bundle preserves release `N+1`,
// which a fixed integer offset expresses without a template language.

import { createHash } from "node:crypto";
import { isSafeGitRefName } from "./repo-context.js";

export const RELEASE_FAMILY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATH_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const FAMILY_KEYS = new Set(["base_branch", "sequence_floor", "version_template", "paths"]);
const MAX_FAMILIES = 32;
const MAX_PATHS = 16;
const MAX_VERSION_TEMPLATE = 64;
const MAX_PATH_TEMPLATE = 240;
export const RELEASE_SEQUENCE_MAX = 1_000_000_000;
export const RELEASE_VERSION_MAX = 64;
export const RELEASE_RENDERED_PATH_MAX = 480;

const TOKEN_RE = /\{([^{}]*)\}/g;
const SEQUENCE_OFFSET_TOKEN_RE = /^sequence[+-][1-9]\d{0,3}$/;
const VERSION_LITERAL_RE = /^[A-Za-z0-9._+-]*$/;
const PATH_LITERAL_RE = /^[A-Za-z0-9._/-]*$/;

/** Split a template into literal text and parsed tokens, or report why it is not one. */
function parseTemplate(template, { allowVersion }) {
  const parts = [];
  let cursor = 0;
  for (const match of template.matchAll(TOKEN_RE)) {
    parts.push({ literal: template.slice(cursor, match.index) });
    const body = match[1];
    if (body === "sequence" || SEQUENCE_OFFSET_TOKEN_RE.test(body)) {
      parts.push({ sequenceOffset: body === "sequence" ? 0 : Number(body.slice("sequence".length)) });
    } else if (allowVersion && body === "version") {
      parts.push({ version: true });
    } else {
      return { ok: false, reason: `unsupported token '{${body}}'` };
    }
    cursor = match.index + match[0].length;
  }
  parts.push({ literal: template.slice(cursor) });
  if (parts.some((part) => part.literal != null && /[{}]/.test(part.literal))) {
    return { ok: false, reason: "unbalanced braces" };
  }
  return { ok: true, parts };
}

function renderParts(parts, sequence, version) {
  return parts.map((part) => {
    if (part.literal != null) return part.literal;
    if (part.version) return version;
    return String(sequence + part.sequenceOffset);
  }).join("");
}

function smallestOffset(parts) {
  return Math.min(0, ...parts.filter((part) => part.sequenceOffset != null).map((part) => part.sequenceOffset));
}

function largestOffset(parts) {
  return Math.max(0, ...parts.filter((part) => part.sequenceOffset != null).map((part) => part.sequenceOffset));
}

function rendersBelowOne(parts, floor) {
  return Number.isInteger(floor) && floor + smallestOffset(parts) < 1;
}

function validateVersionTemplate(field, raw, floor, errors) {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_VERSION_TEMPLATE) {
    errors.push(`${field} must be a non-empty string of at most ${MAX_VERSION_TEMPLATE} characters`);
    return null;
  }
  const parsed = parseTemplate(raw, { allowVersion: false });
  if (!parsed.ok) {
    errors.push(`${field}: ${parsed.reason}`);
    return null;
  }
  const tokens = parsed.parts.filter((part) => part.literal == null);
  if (tokens.length !== 1) {
    errors.push(`${field} must contain exactly one sequence token ({sequence} or {sequence+K} / {sequence-K})`);
    return null;
  }
  if (!parsed.parts.every((part) => part.literal == null || VERSION_LITERAL_RE.test(part.literal))) {
    errors.push(`${field} literals may use only [A-Za-z0-9._+-]`);
    return null;
  }
  if (rendersBelowOne(parsed.parts, floor)) {
    errors.push(`${field} renders a sequence term below 1 at sequence_floor ${floor}`);
  }
  return parsed.parts;
}

function isSafeRepoRelativePath(path) {
  if (!PATH_LITERAL_RE.test(path) || path.startsWith("/") || path.endsWith("/")) return false;
  return path.split("/").every((segment) =>
    segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

const pathsOverlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Whether two derived paths of one identity coincide or one is a directory prefix of another. */
export function releasePathsConflict(paths) {
  const values = Object.values(paths);
  return values.some((a, i) => values.some((b, j) => i < j && pathsOverlap(a, b)));
}

/** Whether any path in `left` coincides with or nests under any path in `right`, whatever their keys. */
export function releasePathSetsOverlap(left, right) {
  return left.some((a) => right.some((b) => pathsOverlap(a, b)));
}

function validatePathTemplate(field, raw, floor, errors) {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_PATH_TEMPLATE) {
    errors.push(`${field} must be a non-empty string of at most ${MAX_PATH_TEMPLATE} characters`);
    return;
  }
  const parsed = parseTemplate(raw, { allowVersion: true });
  if (!parsed.ok) {
    errors.push(`${field}: ${parsed.reason}`);
    return;
  }
  if (parsed.parts.every((part) => part.literal != null)) {
    errors.push(`${field} must contain a sequence token or {version}`);
    return;
  }
  // A sentinel rendering checks the literal skeleton; rendered paths are checked again on use.
  if (!isSafeRepoRelativePath(renderParts(parsed.parts, 1, "1"))) {
    errors.push(`${field} must be a repo-relative path of [A-Za-z0-9._/-] with no empty, '.', '..', or '.git' segment`);
    return;
  }
  if (rendersBelowOne(parsed.parts, floor)) {
    errors.push(`${field} renders a sequence term below 1 at sequence_floor ${floor}`);
  }
}

function validatePaths(prefix, raw, floor, errors) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${prefix}.paths must be a mapping of path key to path template`);
    return;
  }
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.length > MAX_PATHS) {
    errors.push(`${prefix}.paths must declare at least one path and at most ${MAX_PATHS}`);
  }
  for (const key of keys) {
    if (!PATH_KEY_RE.test(key)) {
      errors.push(`${prefix}.paths has an invalid path key '${key}' (lowercase snake_case, at most 40 characters)`);
      continue;
    }
    validatePathTemplate(`${prefix}.paths.${key}`, raw[key], floor, errors);
  }
}

function normalizeFamily(name, raw, defaultBaseBranch, errors) {
  const prefix = `release_families.${name}`;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${prefix} must be a mapping`);
    return null;
  }
  const before = errors.length;
  for (const key of Object.keys(raw)) {
    if (!FAMILY_KEYS.has(key)) errors.push(`${prefix} has unknown key '${key}'`);
  }
  const baseBranch = raw.base_branch ?? defaultBaseBranch;
  if (!isSafeGitRefName(baseBranch)) errors.push(`${prefix}.base_branch must be a safe Git ref name`);
  const floor = raw.sequence_floor;
  if (!Number.isInteger(floor) || floor < 1 || floor > RELEASE_SEQUENCE_MAX) {
    errors.push(`${prefix}.sequence_floor must be a positive integer no greater than ${RELEASE_SEQUENCE_MAX}`);
  }
  validateVersionTemplate(`${prefix}.version_template`, raw.version_template, floor, errors);
  validatePaths(prefix, raw.paths, floor, errors);
  if (errors.length !== before) return null;
  const family = {
    base_branch: baseBranch,
    sequence_floor: floor,
    version_template: raw.version_template,
    paths: Object.fromEntries(Object.entries(raw.paths)),
  };
  if (!releaseSequenceRenderable(family, floor)) {
    errors.push(`${prefix} must render a supported identity at sequence_floor ${floor}`);
    return null;
  }
  const atFloor = renderReleaseIdentity(family, floor);
  if (atFloor.version.length > RELEASE_VERSION_MAX) {
    errors.push(`${prefix}.version_template renders more than ${RELEASE_VERSION_MAX} characters`);
    return null;
  }
  if (Object.values(atFloor.paths).some((path) => !isSafeRenderedReleasePath(path))) {
    errors.push(`${prefix}.paths must render repo-relative paths of at most ${RELEASE_RENDERED_PATH_MAX} characters`);
    return null;
  }
  if (releasePathsConflict(atFloor.paths)) {
    errors.push(`${prefix}.paths must render distinct paths, none inside another`);
    return null;
  }
  return family;
}

export function normalizeReleaseFamiliesConfig(raw, { defaultBaseBranch = "dev" } = {}) {
  if (raw == null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["release_families must be a mapping of family name to family definition"] };
  }
  const names = Object.keys(raw);
  if (names.length > MAX_FAMILIES) {
    return { ok: false, errors: [`release_families declares more than ${MAX_FAMILIES} families`] };
  }
  const errors = [];
  const entries = [];
  for (const name of names) {
    if (!RELEASE_FAMILY_NAME_RE.test(name)) {
      errors.push(`release_families has an invalid family name '${name}' (lowercase [a-z0-9-], at most 40 characters)`);
      continue;
    }
    const family = normalizeFamily(name, raw[name], defaultBaseBranch, errors);
    if (family) entries.push([name, family]);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: Object.fromEntries(entries) };
}

/** Whether `sequence` renders within bounds for every template of the family. */
export function releaseSequenceRenderable(family, sequence) {
  const templates = [family.version_template, ...Object.values(family.paths)];
  return Number.isInteger(sequence) && sequence >= 1 && templates.every((template) => {
    const { parts } = parseTemplate(template, { allowVersion: true });
    return sequence + smallestOffset(parts) >= 1 && sequence + largestOffset(parts) <= RELEASE_SEQUENCE_MAX;
  });
}

/** The version and every derived path of a normalized family at `sequence`. */
export function renderReleaseIdentity(family, sequence) {
  const version = renderParts(parseTemplate(family.version_template, { allowVersion: false }).parts, sequence, "");
  const paths = {};
  for (const [key, template] of Object.entries(family.paths)) {
    paths[key] = renderParts(parseTemplate(template, { allowVersion: true }).parts, sequence, version);
  }
  return { sequence, version, paths };
}

export function isSafeRenderedReleasePath(path) {
  return typeof path === "string" && path.length <= RELEASE_RENDERED_PATH_MAX && isSafeRepoRelativePath(path);
}

/** SHA-256 over the normalized definition with sorted keys, so key order never changes it. */
export function releaseFamilyDigest(family) {
  const canonical = JSON.stringify({
    base_branch: family.base_branch,
    sequence_floor: family.sequence_floor,
    version_template: family.version_template,
    // Explicit code-unit order keeps the durable digest byte-identical across host locales.
    paths: Object.fromEntries(Object.entries(family.paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
