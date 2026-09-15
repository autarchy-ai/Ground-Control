// The release-identity reservation log in Git references (issue #1579, ADR-097).
//
// Allocation rests on one primitive GitHub was observed to enforce: creating a reference that
// already exists fails. A `force: false` update was NOT safe — a live check accepted a
// non-fast-forward sibling — so nothing here updates or deletes a reference.
//
//   refs/gc/release-identities/<family>/claims/<slot>    parent: base commit
//   refs/gc/release-identities/<family>/outcomes/<slot>  parent: that slot's claim commit
//
// Slots are contiguous append positions, not release sequences. Every contender for the next
// append races on the same slot even when it read a different base or floor, and a claim names
// its predecessor, so a stale caller can never land a lower sequence after a higher one.

import { isSafeGitRefName } from "./repo-context.js";
import {
  RELEASE_FAMILY_NAME_RE,
  RELEASE_SEQUENCE_MAX,
  RELEASE_VERSION_MAX,
  isSafeRenderedReleasePath,
  normalizeReleaseFamiliesConfig,
  releaseFamilyDigest,
  releaseSequenceRenderable,
  renderReleaseIdentity,
} from "./release-identity-config.js";

export const RELEASE_IDENTITY_EVENT_SCHEMA = "gc.release-identity-event/v1";
export const RELEASE_IDENTITY_ABANDON_REASONS = Object.freeze([
  "capture_not_needed",
  "generation_failed",
  "superseded",
  "run_abandoned",
]);
export const RELEASE_LEDGER_SLOTS_MAX = 10_000;

const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SLOT_SEGMENT_RE = /^[1-9]\d{0,4}$/;
const SUBJECT_RE = /^gc release identity: ([a-z0-9-]+) slot (\d+) #(\d+) (reserved|published|abandoned)$/;
const COMMIT_CACHE_MAX = 4096;

export function releaseLedgerNamespace(family) {
  return `gc/release-identities/${family}/`;
}

export function releaseLedgerRef(family, kind, slot) {
  return `refs/${releaseLedgerNamespace(family)}${kind}/${slot}`;
}

export const RELEASE_EVENT_MESSAGE_MAX = 16_384;

export function buildReleaseEventMessage(event) {
  return `gc release identity: ${event.family} slot ${event.slot} #${event.sequence} ${event.event}\n\n${JSON.stringify(event)}\n`;
}

/**
 * The message for `event` only if the fold would accept it back unchanged. Every write goes
 * through here, so the server can never create an event — and a permanent reference to it — that
 * its own validator later rejects as a malformed log.
 */
export function buildValidatedReleaseEventMessage(event) {
  const message = buildReleaseEventMessage(event);
  const parsed = parseReleaseEventMessage(message);
  return parsed != null && sameJson(parsed, event) ? message : null;
}

const isObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const COMMON_KEYS = ["schema", "repository", "family", "slot", "sequence", "event", "issue_number", "idempotency_hash"];
const CLAIM_KEYS = [...COMMON_KEYS, "branch", "previous_claim", "version", "paths", "base_branch", "base_revision", "family_definition", "family_digest"];

/** The branch of the run that owns an issue's reservations: `<issue>-<slug>`. */
export function isReleaseIssueBranch(branch, issueNumber) {
  return typeof branch === "string" && branch.startsWith(`${issueNumber}-`) && branch.length > `${issueNumber}-`.length
    && isSafeGitRefName(branch);
}

/** A stored definition must be exactly what the normalizer produces, and must render this claim. */
function claimRendersFromDefinition(event) {
  const definition = event.family_definition;
  if (!isObject(definition)) return false;
  const normalized = normalizeReleaseFamiliesConfig({ [event.family]: definition }, { defaultBaseBranch: definition.base_branch });
  if (!normalized.ok || !sameJson(normalized.value[event.family], definition)) return false;
  if (event.base_branch !== definition.base_branch || event.family_digest !== releaseFamilyDigest(definition)) return false;
  if (!releaseSequenceRenderable(definition, event.sequence)) return false;
  const rendered = renderReleaseIdentity(definition, event.sequence);
  return rendered.version === event.version && sameJson(rendered.paths, event.paths);
}

const EVENT_SHAPES = {
  reserved: {
    keys: CLAIM_KEYS,
    valid: (e) => isReleaseIssueBranch(e.branch, e.issue_number)
      && (e.previous_claim === null || OBJECT_ID_RE.test(e.previous_claim))
      && OBJECT_ID_RE.test(e.base_revision) && HASH_RE.test(e.family_digest)
      && typeof e.version === "string" && e.version.length <= RELEASE_VERSION_MAX
      && isObject(e.paths) && Object.values(e.paths).every(isSafeRenderedReleasePath)
      && claimRendersFromDefinition(e),
  },
  published: {
    keys: [...COMMON_KEYS, "published_revision", "artifacts"],
    valid: (e) => OBJECT_ID_RE.test(e.published_revision) && isObject(e.artifacts)
      && Object.values(e.artifacts).every((sha) => OBJECT_ID_RE.test(sha)),
  },
  abandoned: {
    keys: [...COMMON_KEYS, "reason"],
    valid: (e) => RELEASE_IDENTITY_ABANDON_REASONS.includes(e.reason),
  },
};

const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function hasValidCommonFields(event) {
  return event.schema === RELEASE_IDENTITY_EVENT_SCHEMA
    && typeof event.repository === "string"
    && RELEASE_FAMILY_NAME_RE.test(event.family)
    && inRange(event.slot, 1, RELEASE_LEDGER_SLOTS_MAX)
    && inRange(event.sequence, 1, RELEASE_SEQUENCE_MAX)
    && inRange(event.issue_number, 1, Number.MAX_SAFE_INTEGER)
    && HASH_RE.test(event.idempotency_hash);
}

function parseEventBody(text) {
  try {
    const event = JSON.parse(text);
    return isObject(event) ? event : null;
  } catch {
    return null;
  }
}

/** Parse and strictly validate an event commit message; null when it is not a supported event. */
export function parseReleaseEventMessage(message) {
  if (typeof message !== "string" || message.length > RELEASE_EVENT_MESSAGE_MAX) return null;
  const split = message.indexOf("\n\n");
  const subject = SUBJECT_RE.exec(split < 0 ? "" : message.slice(0, split));
  const event = subject ? parseEventBody(message.slice(split + 2)) : null;
  const shape = event ? EVENT_SHAPES[event.event] : null;
  if (!shape || !hasExactKeys(event, shape.keys) || !hasValidCommonFields(event) || !shape.valid(event)) return null;
  const [, family, slot, sequence, kind] = subject;
  const subjectMatches = family === event.family && Number(slot) === event.slot
    && Number(sequence) === event.sequence && kind === event.event;
  return subjectMatches ? event : null;
}

const commitCache = new Map();

async function readCommitCached(api, sha) {
  const key = `${api.repository.toLowerCase()}@${sha}`;
  if (commitCache.has(key)) return commitCache.get(key);
  const commit = await api.readCommit(sha);
  if (commitCache.size >= COMMIT_CACHE_MAX) commitCache.delete(commitCache.keys().next().value);
  commitCache.set(key, commit);
  return commit;
}

export function resetReleaseLedgerCacheForTest() {
  commitCache.clear();
}

const malformed = (detail) => ({ ok: false, error: "release_identity_log_malformed", detail });

/** `{ kind, slot }` for a well-formed ledger reference in `namespace`, otherwise null. */
function parseLedgerRef(namespace, { ref, sha }) {
  if (typeof ref !== "string" || !ref.startsWith(namespace) || !OBJECT_ID_RE.test(sha ?? "")) return null;
  const tail = ref.slice(namespace.length).split("/");
  const [kind, segment] = tail;
  const wellFormed = tail.length === 2 && (kind === "claims" || kind === "outcomes") && SLOT_SEGMENT_RE.test(segment);
  return wellFormed ? { kind, slot: Number(segment) } : null;
}

function shapeProblem(claims, outcomes) {
  if (claims.size > RELEASE_LEDGER_SLOTS_MAX) return "the log exceeds the supported size";
  for (let slot = 1; slot <= claims.size; slot += 1) {
    if (!claims.has(slot)) return "the claim slots are not contiguous from 1";
  }
  const orphan = [...outcomes.keys()].find((slot) => !claims.has(slot));
  return orphan == null ? null : `outcome ${orphan} has no claim`;
}

function classifyRefs(refs, family) {
  const namespace = `refs/${releaseLedgerNamespace(family)}`;
  const claims = new Map();
  const outcomes = new Map();
  for (const entry of refs) {
    const parsed = parseLedgerRef(namespace, entry);
    if (parsed == null) return { error: malformed("an unexpected reference is present in the family namespace") };
    (parsed.kind === "claims" ? claims : outcomes).set(parsed.slot, entry.sha);
  }
  const problem = shapeProblem(claims, outcomes);
  return problem ? { error: malformed(problem) } : { claims, outcomes };
}

async function readEvent(api, sha, family, slot, kinds) {
  const commit = await readCommitCached(api, sha);
  const event = parseReleaseEventMessage(commit.message);
  const valid = event && kinds.includes(event.event) && event.family === family && event.slot === slot
    && event.repository.toLowerCase() === api.repository.toLowerCase() && commit.parents.length === 1;
  return valid ? { commit, event } : null;
}

function outcomeFollowsClaim(outcome, claim) {
  const { event, commit } = outcome;
  if (commit.parents[0] !== claim.commit.sha || commit.treeSha !== claim.commit.treeSha) return false;
  if (event.sequence !== claim.event.sequence || event.issue_number !== claim.event.issue_number
    || event.idempotency_hash !== claim.event.idempotency_hash) return false;
  const sortKeys = (keys) => keys.sort((a, b) => a.localeCompare(b));
  return event.event !== "published" || sameJson(sortKeys(Object.keys(event.artifacts)), sortKeys(Object.keys(claim.event.paths)));
}

/**
 * Read and validate a family's complete log. Any inconsistency fails closed: nothing here repairs
 * a log, and allocating from one that is not understood could reissue an identity.
 */
export async function foldReleaseLedger(api, family) {
  const classified = classifyRefs(await api.listRefs(releaseLedgerNamespace(family)), family);
  if (classified.error) return classified.error;
  const reservations = [];
  const identities = new Set();
  for (let slot = 1; slot <= classified.claims.size; slot += 1) {
    const read = await readSlot(api, family, slot, classified, reservations.at(-1) ?? null);
    if (read.error) return read.error;
    const identity = `${read.reservation.claim.event.issue_number}:${read.reservation.claim.event.idempotency_hash}`;
    if (identities.has(identity)) return malformed(`claim slot ${slot} repeats an idempotency identity`);
    identities.add(identity);
    reservations.push(read.reservation);
  }
  return { ok: true, reservations, next_slot: reservations.length + 1, highest: reservations.at(-1)?.sequence ?? 0 };
}

/** One slot's claim and optional outcome, validated against the slot before it. */
async function readSlot(api, family, slot, classified, previous) {
  const claim = await readEvent(api, classified.claims.get(slot), family, slot, ["reserved"]);
  const base = claim == null ? null : await readCommitCached(api, claim.event.base_revision);
  const linked = claim && claim.commit.parents[0] === claim.event.base_revision
    && claim.commit.treeSha === base.treeSha
    && claim.event.previous_claim === (previous?.claim.commit.sha ?? null)
    && claim.event.sequence > (previous?.sequence ?? 0);
  if (!linked) return { error: malformed(`claim slot ${slot} is not a valid successor in the log`) };
  const outcomeSha = classified.outcomes.get(slot);
  if (outcomeSha == null) return { reservation: { slot, sequence: claim.event.sequence, claim, outcome: null } };
  const outcome = await readEvent(api, outcomeSha, family, slot, ["published", "abandoned"]);
  if (!outcome || !outcomeFollowsClaim(outcome, claim)) return { error: malformed(`outcome slot ${slot} does not follow its claim`) };
  return { reservation: { slot, sequence: claim.event.sequence, claim, outcome } };
}

/**
 * Create a ledger reference, deciding every failure by reading the exact reference back: a 422
 * is not proof of contention, since GitHub also returns it for validation and abuse refusals.
 * Returns "created", "taken" (another object owns the name), or "undecided".
 */
export async function createLedgerRef(api, ref, sha) {
  try {
    await api.createRef(ref, sha);
    return "created";
  } catch {
    let current;
    try {
      current = await api.readRef(ref);
    } catch {
      return "undecided";
    }
    if (current == null) return "undecided";
    return current === sha ? "created" : "taken";
  }
}
