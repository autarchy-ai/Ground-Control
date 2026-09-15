// gc_release_identity — reserve, publish, abandon, and inspect versioned artifact-release
// identities (issue #1579, ADR-097).
//
// The repository's reference log is the only allocation authority. The caller names an issue, a
// configured family, and a workflow idempotency key; the repository, base revision, version, and
// paths all come from the server. Every GitHub failure maps to a fixed message: `gh` stderr and
// argv never reach a result.

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { ASYNC_JOB_IDEMPOTENCY_KEY_MAX, ASYNC_JOB_IDEMPOTENCY_KEY_RE } from "./async-job-registry.js";
import { issueRepositoryNotAuthorized, resolveAuthorizedIssueRepository } from "./authorized-issue-repository.js";
import { parseGroundControlYaml } from "./ground-control-config.js";
import { resolveMcpLaunchWorkspaceAuthorization } from "./grc-legacy-compat-4.js";
import { getRepoGroundControlContext } from "./repo-vocabulary-2.js";
import { GITHUB_REPO_RE } from "./runtime-primitives.js";
import {
  RELEASE_FAMILY_NAME_RE,
  releaseFamilyDigest,
  releasePathSetsOverlap,
  releasePathsConflict,
  releaseSequenceRenderable,
  renderReleaseIdentity,
} from "./release-identity-config.js";
import { githubReleaseLedgerApi } from "./release-identity-github.js";
import {
  RELEASE_IDENTITY_ABANDON_REASONS,
  RELEASE_IDENTITY_EVENT_SCHEMA,
  RELEASE_LEDGER_SLOTS_MAX,
  buildValidatedReleaseEventMessage,
  createLedgerRef,
  foldReleaseLedger,
  isReleaseIssueBranch,
  releaseLedgerRef,
} from "./release-identity-ledger.js";
import { readReleaseCheckoutBranch, releasePathOutsideCheckout } from "./release-identity-checkout.js";
import { ensureReleaseIdentityRecords, isTrustedImplementRunBranch } from "./release-identity-records.js";

export const RELEASE_IDENTITY_ACTIONS = Object.freeze(["reserve", "publish", "abandon", "status"]);
const CLAIM_ATTEMPTS_MAX = 8;
const HEAD_OBSERVATIONS_MAX = 3;
const BASE_CONFIG_MAX_BYTES = 256 * 1024;
const STATUS_RESERVATIONS_MAX = 200;

function refuse(error, message, nextAction, fields = {}) {
  return { ok: false, error, message, ...fields, next_action: nextAction };
}

const githubUnavailable = (action) => refuse(
  "release_identity_github_unavailable",
  "a GitHub read or write for the reservation log did not complete",
  "restore_github_access_and_retry_with_the_same_idempotency_key",
  { action },
);

const undecided = (action) => refuse(
  "release_identity_write_undecided",
  "a reservation-log write could not be confirmed or refuted; no further identity was attempted",
  "retry_with_the_same_idempotency_key",
  { action },
);

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isIdempotencyKey = (value) => typeof value === "string"
  && value.length <= ASYNC_JOB_IDEMPOTENCY_KEY_MAX && ASYNC_JOB_IDEMPOTENCY_KEY_RE.test(value);

// Each check is [accepts(input), error, message, next_action]; the first rejection wins.
const INPUT_CHECKS = [
  [(i) => RELEASE_IDENTITY_ACTIONS.includes(i.action), "release_identity_action_invalid",
    `action must be one of ${RELEASE_IDENTITY_ACTIONS.join(", ")}`, "supply_a_valid_action_and_retry"],
  [(i) => typeof i.repoPath === "string" && isAbsolute(i.repoPath), "release_identity_repo_path_invalid",
    "repo_path must be an absolute path to the authorized checkout", "supply_the_absolute_invocation_root_and_retry"],
  [(i) => typeof i.family === "string" && RELEASE_FAMILY_NAME_RE.test(i.family), "release_identity_family_invalid",
    "family must be a release family name", "supply_a_configured_family_and_retry"],
  [(i) => (i.action === "status" && i.issueNumber == null) || isPositiveInteger(i.issueNumber), "release_identity_issue_number_invalid",
    "issue_number must be a positive integer", "supply_a_valid_issue_number_and_retry"],
  [(i) => (i.action === "status" ? i.idempotencyKey == null : isIdempotencyKey(i.idempotencyKey)), "release_identity_idempotency_key_invalid",
    "idempotency_key is a bounded [A-Za-z0-9._:-] key, required for reserve, publish, and abandon and not accepted by status",
    "supply_the_workflow_idempotency_key_and_retry"],
  [(i) => (i.action === "abandon" ? RELEASE_IDENTITY_ABANDON_REASONS.includes(i.reason) : i.reason == null), "release_identity_reason_invalid",
    `reason is required for abandon, one of ${RELEASE_IDENTITY_ABANDON_REASONS.join(", ")}, and not accepted otherwise`,
    "supply_a_valid_reason_code_only_with_abandon_and_retry"],
];

// The library is callable directly, so it refuses a field the MCP schema would never pass — a
// repository, revision, version, or path above all — instead of silently ignoring it.
const INPUT_FIELDS = new Set(["action", "repoPath", "issueNumber", "family", "idempotencyKey", "reason"]);

function validateInput(input) {
  const unexpected = Object.keys(input ?? {}).filter((key) => !INPUT_FIELDS.has(key));
  if (input == null || typeof input !== "object" || unexpected.length > 0) {
    return refuse("release_identity_input_unexpected_field", `unsupported input fields: ${unexpected.join(", ") || "input must be an object"}`,
      "call_with_only_action_repo_path_issue_number_family_idempotency_key_and_reason");
  }
  const failed = INPUT_CHECKS.find(([accepts]) => !accepts(input));
  return failed ? refuse(failed[1], failed[2], failed[3]) : null;
}

/**
 * The run authority for mutations that assert something about a run: the issue branch checked out
 * in the launch workspace plus this server identity's durable pickup record for that association.
 * A caller naming another issue, family, key, and locally forged branch cannot reserve for or
 * abandon a run it is not.
 */
async function requireRunBranch(ctx, expectedBranch) {
  const active = await ctx.readActiveBranch(ctx.repoRoot);
  const branchMatches = expectedBranch == null ? isReleaseIssueBranch(active, ctx.issueNumber) : active === expectedBranch;
  if (branchMatches && await isTrustedImplementRunBranch(ctx.api, ctx.issueNumber, active)) {
    return { ok: true, branch: active };
  }
  return refuse(
    "release_identity_run_not_authorized",
    expectedBranch == null
      ? `a reservation for issue #${ctx.issueNumber} requires that issue's active branch and its trusted /implement pickup record`
      : "only the run recorded by the trusted /implement pickup and the claim can abandon this reservation",
    "restore_the_trusted_issue_branch_pickup_record_and_retry",
  );
}

function toView(repository, family, reservation) {
  const { event: claim, commit } = reservation.claim;
  const outcome = reservation.outcome?.event ?? null;
  return {
    reservation_id: `${family}#${reservation.sequence}`,
    repository,
    family,
    slot: reservation.slot,
    sequence: reservation.sequence,
    version: claim.version,
    paths: claim.paths,
    base_branch: claim.base_branch,
    base_revision: claim.base_revision,
    family_digest: claim.family_digest,
    issue_number: claim.issue_number,
    idempotency_hash: claim.idempotency_hash,
    branch: claim.branch,
    state: outcome?.event ?? "reserved",
    claim_ref: releaseLedgerRef(family, "claims", reservation.slot),
    claim_commit: commit.sha,
    ...(outcome ? { outcome_ref: releaseLedgerRef(family, "outcomes", reservation.slot), outcome_commit: reservation.outcome.commit.sha } : {}),
    ...(outcome?.event === "published" ? { published_revision: outcome.published_revision, artifacts: outcome.artifacts } : {}),
    ...(outcome?.event === "abandoned" ? { reason: outcome.reason } : {}),
  };
}

const NEXT_ACTION_BY_STATE = {
  reserved: "generate_the_capture_at_the_returned_paths",
  published: "none",
  abandoned: "reserve_again_with_a_new_idempotency_key_if_a_new_identity_is_needed",
};

async function respondWithRecords(ctx, reservation, reused) {
  const view = toView(ctx.api.repository, ctx.family, reservation);
  const records = await ensureReleaseIdentityRecords(ctx.api, ctx.repoRoot, view);
  if (!records.ok) {
    return refuse(
      "release_identity_issue_record_failed",
      `the reservation log is committed, but ${records.message}`,
      "retry_with_the_same_idempotency_key_to_post_the_missing_records",
      { action: ctx.action, reservation: view, pending_records: records.pending },
    );
  }
  return { ok: true, action: ctx.action, reused, reservation: view, issue_records: records.urls, next_action: NEXT_ACTION_BY_STATE[view.state] };
}

function logMalformed(fold) {
  return refuse("release_identity_log_malformed", `the family's reservation log failed validation: ${fold.detail}`, "inspect_the_reservation_log_references_before_retrying");
}

const ownedBy = (fold, ctx) => fold.reservations.find((r) =>
  r.claim.event.issue_number === ctx.issueNumber && r.claim.event.idempotency_hash === ctx.idempotencyHash) ?? null;

async function checkIssue(api, issueNumber, { requireOpen }) {
  const issue = await api.readIssue(issueNumber);
  if (issue?.number !== issueNumber || issue.pull_request != null) {
    return refuse("release_identity_issue_not_an_issue", "issue_number does not identify an issue in the authorized repository", "supply_the_issue_number_of_this_run_and_retry");
  }
  if (requireOpen && issue.state !== "open") {
    return refuse("release_identity_issue_not_open", "a new reservation can only be made for an open issue", "reserve_from_the_open_issue_of_this_run");
  }
  return null;
}

async function readBaseFamily(ctx, baseBranch) {
  const head = await ctx.api.branchHead(baseBranch);
  if (head == null) {
    return refuse("release_identity_base_branch_missing", "the family's base branch does not exist in the authorized repository", "correct_the_family_base_branch_and_retry");
  }
  const entry = await ctx.api.lookupPath(head.treeSha, ".ground-control.yaml");
  const text = entry.kind === "file" ? await ctx.api.readBlobText(entry.sha, BASE_CONFIG_MAX_BYTES) : null;
  const parsed = text == null ? null : parseGroundControlYaml(text);
  const declared = parsed?.ok ? parsed.value.github_repo : null;
  if (declared != null && declared.toLowerCase() !== ctx.api.repository.toLowerCase()) {
    return refuse("release_identity_base_repo_mismatch", "the base configuration declares a different github_repo than the authorized repository", "correct_github_repo_on_the_base_branch_and_retry");
  }
  const family = parsed?.ok ? parsed.value.release_families[ctx.family] : null;
  if (family == null || family.base_branch !== baseBranch) {
    return refuse(
      "release_identity_family_not_on_base",
      "the family is not defined with this base branch in .ground-control.yaml at the base head; a family is active only once its definition is on the base branch",
      "merge_the_release_family_definition_into_the_base_branch_and_retry",
    );
  }
  return { ok: true, head, family };
}

/** Why `identity` cannot be claimed without making an artifact ambiguous, or null. */
async function identityCollision(ctx, fold, identity, baseTreeSha) {
  if (releasePathsConflict(identity.paths)) return "its derived paths coincide or nest";
  for (const other of fold.reservations) {
    if (other.claim.event.version === identity.version
      || releasePathSetsOverlap(Object.values(other.claim.event.paths), Object.values(identity.paths))) {
      return `its version or a path is already owned by ${ctx.family}#${other.sequence}`;
    }
  }
  for (const path of Object.values(identity.paths)) {
    // Anything but `absent` collides: an existing entry of any kind, or a non-directory ancestor.
    if ((await ctx.api.lookupPath(baseTreeSha, path)).kind !== "absent") return "a derived path already exists at the base head";
  }
  return null;
}

async function claimNext(ctx, base, fold, branch) {
  const { api, family } = ctx;
  const sequence = Math.max(base.family.sequence_floor, fold.highest + 1);
  if (!releaseSequenceRenderable(base.family, sequence) || fold.next_slot > RELEASE_LEDGER_SLOTS_MAX) {
    return { result: refuse("release_identity_sequence_exhausted", "the family has no renderable identity left", "declare_a_new_release_family") };
  }
  const identity = renderReleaseIdentity(base.family, sequence);
  const outside = releasePathOutsideCheckout(ctx.repoRoot, identity.paths);
  if (outside != null) {
    return { result: refuse("release_identity_path_escapes_checkout", `derived path '${outside}' does not resolve inside the checkout`, "remove_the_symlink_or_correct_the_path_template_and_retry") };
  }
  const collision = await identityCollision(ctx, fold, identity, base.head.treeSha);
  if (collision) {
    return { result: refuse("release_identity_identity_collision", `sequence ${sequence} cannot be reserved: ${collision}`, "raise_the_sequence_floor_or_keep_family_outputs_disjoint_and_retry") };
  }
  const event = {
    schema: RELEASE_IDENTITY_EVENT_SCHEMA,
    repository: api.repository,
    family,
    slot: fold.next_slot,
    sequence,
    event: "reserved",
    issue_number: ctx.issueNumber,
    idempotency_hash: ctx.idempotencyHash,
    branch,
    previous_claim: fold.reservations.at(-1)?.claim.commit.sha ?? null,
    version: identity.version,
    paths: identity.paths,
    base_branch: base.family.base_branch,
    base_revision: base.head.sha,
    family_definition: base.family,
    family_digest: releaseFamilyDigest(base.family),
  };
  const message = buildValidatedReleaseEventMessage(event);
  if (message == null) {
    return { result: refuse("release_identity_identity_unrepresentable", `sequence ${sequence} renders a version, path, or event beyond the log's bounds`, "shorten_the_family_templates_and_retry") };
  }
  const commitSha = await api.createCommit({ message, treeSha: base.head.treeSha, parentSha: base.head.sha });
  return { outcome: await createLedgerRef(api, releaseLedgerRef(family, "claims", fold.next_slot), commitSha) };
}

async function claimAvailableIdentity(ctx, base, fold, branch) {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS_MAX; attempt += 1) {
    const claimed = await claimNext(ctx, base, fold, branch);
    if (claimed.result) return claimed.result;
    if (claimed.outcome === "undecided") return undecided(ctx.action);
    fold = await foldReleaseLedger(ctx.api, ctx.family);
    if (!fold.ok) return logMalformed(fold);
    // Whoever won the slot, re-check idempotency before considering the next one.
    const owned = ownedBy(fold, ctx);
    if (owned) return respondWithRecords(ctx, owned, claimed.outcome !== "created");
  }
  return refuse("release_identity_allocation_contended", `no identity could be claimed in ${CLAIM_ATTEMPTS_MAX} attempts`, "retry_with_the_same_idempotency_key", { action: ctx.action });
}

async function reserve(ctx) {
  const fold = await foldReleaseLedger(ctx.api, ctx.family);
  if (!fold.ok) return logMalformed(fold);
  // Replay precedes every new-claim check: a reservation stays retrievable after its issue closes,
  // its family is removed from configuration, or its artifact lands.
  const existing = ownedBy(fold, ctx);
  if (existing) return respondWithRecords(ctx, existing, true);

  const notIssue = await checkIssue(ctx.api, ctx.issueNumber, { requireOpen: true });
  if (notIssue) return notIssue;
  if (ctx.localFamilies == null) {
    return refuse("release_identity_config_invalid", "the checkout's .ground-control.yaml is missing or invalid", "repair_the_ground_control_configuration_and_retry");
  }
  const local = ctx.localFamilies[ctx.family];
  if (local == null) {
    return refuse("release_identity_family_not_configured", "the family is not declared under release_families in .ground-control.yaml", "declare_the_release_family_and_retry");
  }
  const run = await requireRunBranch(ctx, null);
  if (!run.ok) return run;
  const base = await readBaseFamily(ctx, local.base_branch);
  return base.ok ? claimAvailableIdentity(ctx, base, fold, run.branch) : base;
}

async function appendOutcome(ctx, reservation, fields) {
  const claim = reservation.claim;
  const event = {
    schema: RELEASE_IDENTITY_EVENT_SCHEMA,
    repository: ctx.api.repository,
    family: ctx.family,
    slot: reservation.slot,
    sequence: reservation.sequence,
    event: fields.event,
    issue_number: claim.event.issue_number,
    idempotency_hash: claim.event.idempotency_hash,
    ...fields,
  };
  const message = buildValidatedReleaseEventMessage(event);
  if (message == null) return "unrepresentable";
  const commitSha = await ctx.api.createCommit({ message, treeSha: claim.commit.treeSha, parentSha: claim.commit.sha });
  return createLedgerRef(ctx.api, releaseLedgerRef(ctx.family, "outcomes", reservation.slot), commitSha);
}

function terminalRefusal(ctx, reservation) {
  const view = toView(ctx.api.repository, ctx.family, reservation);
  if (view.state === "published") {
    return refuse("release_identity_already_published", "the reservation is already published", "leave_the_published_reservation_in_place", { reservation: view });
  }
  return refuse("release_identity_reservation_abandoned", "the reservation was abandoned; its identity is never reissued", NEXT_ACTION_BY_STATE.abandoned, { reservation: view });
}

/** Shared shape of publish and abandon: replay, decide, append once, then converge on the winner. */
async function transition(ctx, { isIdenticalOutcome, decide }) {
  const fold = await foldReleaseLedger(ctx.api, ctx.family);
  if (!fold.ok) return logMalformed(fold);
  const reservation = ownedBy(fold, ctx);
  if (reservation == null) {
    return refuse("release_identity_reservation_not_found", "no reservation exists for this issue, family, and idempotency key", "reserve_first_or_supply_the_key_used_to_reserve");
  }
  if (reservation.outcome) {
    return isIdenticalOutcome(reservation.outcome.event) ? respondWithRecords(ctx, reservation, true) : terminalRefusal(ctx, reservation);
  }
  const notIssue = await checkIssue(ctx.api, ctx.issueNumber, { requireOpen: false });
  if (notIssue) return notIssue;
  const decided = await decide(reservation);
  if (decided.result) return decided.result;
  const created = await appendOutcome(ctx, reservation, decided.fields);
  if (created === "unrepresentable") {
    return refuse("release_identity_identity_unrepresentable", "the outcome event would exceed the log's bounds", "inspect_the_reservation_log_references_before_retrying");
  }
  if (created === "undecided") return undecided(ctx.action);
  const settled = await foldReleaseLedger(ctx.api, ctx.family);
  if (!settled.ok) return logMalformed(settled);
  const winner = ownedBy(settled, ctx);
  // A read that does not yet show the outcome the create just decided cannot say who won.
  if (winner?.outcome == null) return undecided(ctx.action);
  if (!isIdenticalOutcome(winner.outcome.event)) return terminalRefusal(ctx, winner);
  return respondWithRecords(ctx, winner, created === "taken");
}

async function verifyArtifactsAt(ctx, paths, head) {
  const artifacts = {};
  const missing = [];
  for (const [key, path] of Object.entries(paths)) {
    const entry = await ctx.api.lookupPath(head.treeSha, path);
    if (entry.kind === "file") artifacts[key] = entry.sha;
    else missing.push(key);
  }
  return { artifacts, missing };
}

function publish(ctx) {
  return transition(ctx, {
    // Converge on a winning publication even if it observed a different head than this call.
    isIdenticalOutcome: (outcome) => outcome.event === "published",
    async decide(reservation) {
      const claim = reservation.claim.event;
      let head = await ctx.api.branchHead(claim.base_branch);
      for (let observation = 0; observation < HEAD_OBSERVATIONS_MAX; observation += 1) {
        if (head == null) {
          return { result: refuse("release_identity_base_branch_missing", "the reservation's base branch no longer exists", "restore_the_base_branch_and_retry") };
        }
        const { artifacts, missing } = await verifyArtifactsAt(ctx, claim.paths, head);
        if (missing.length > 0) {
          return {
            result: refuse(
              "release_identity_artifacts_missing_on_base",
              `the reserved artifacts are not regular files at the base head: ${missing.join(", ")}`,
              "merge_the_artifacts_into_the_base_branch_and_retry",
              { missing_path_keys: missing, reservation: toView(ctx.api.repository, ctx.family, reservation) },
            ),
          };
        }
        const again = await ctx.api.branchHead(claim.base_branch);
        if (again?.sha === head.sha) return { fields: { event: "published", published_revision: head.sha, artifacts } };
        head = again;
      }
      return { result: refuse("release_identity_base_unstable", "the base branch kept advancing while the artifacts were verified", "retry_with_the_same_idempotency_key") };
    },
  });
}

function abandon(ctx) {
  return transition(ctx, {
    isIdenticalOutcome: (outcome) => outcome.event === "abandoned" && outcome.reason === ctx.reason,
    // Publication records only what the server verifies, so any run may record it. Abandonment is
    // a claim about a run's intent and burns the identity, so only that run may make it.
    async decide(reservation) {
      const run = await requireRunBranch(ctx, reservation.claim.event.branch);
      return run.ok ? { fields: { event: "abandoned", reason: ctx.reason } } : { result: run };
    },
  });
}

async function status(ctx) {
  const fold = await foldReleaseLedger(ctx.api, ctx.family);
  if (!fold.ok) return logMalformed(fold);
  const matching = fold.reservations.filter((r) => ctx.issueNumber == null || r.claim.event.issue_number === ctx.issueNumber);
  return {
    ok: true,
    action: "status",
    family: ctx.family,
    highest_sequence: fold.highest,
    total: matching.length,
    complete: matching.length <= STATUS_RESERVATIONS_MAX,
    reservations: matching.slice(-STATUS_RESERVATIONS_MAX).map((r) => toView(ctx.api.repository, ctx.family, r)),
    next_action: "none",
  };
}

const OPERATIONS = { reserve, publish, abandon, status };

export async function runReleaseIdentity(input, {
  workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
  restJson,
  getContext = getRepoGroundControlContext,
  readActiveBranch = readReleaseCheckoutBranch,
} = {}) {
  const invalid = validateInput(input);
  if (invalid) return invalid;
  const repository = await resolveAuthorizedIssueRepository(input.repoPath, workspaceAuthorizationResolver);
  if (!repository.ok) return issueRepositoryNotAuthorized("release_identity", repository, { action: input.action });
  if (!GITHUB_REPO_RE.test(`${repository.owner}/${repository.name}`)) {
    return refuse("release_identity_repo_not_authorized", "the authorized repository identity is not a valid owner/name", "restart_the_mcp_server_from_the_authorized_checkout_and_retry");
  }
  const ctx = {
    action: input.action,
    api: githubReleaseLedgerApi({ repoRoot: repository.repoRoot, owner: repository.owner, name: repository.name, ...(restJson ? { restJson } : {}) }),
    repoRoot: repository.repoRoot,
    family: input.family,
    issueNumber: input.issueNumber ?? null,
    idempotencyHash: input.idempotencyKey == null ? null : createHash("sha256").update(input.idempotencyKey).digest("hex"),
    reason: input.reason ?? null,
    localFamilies: null,
    readActiveBranch,
  };
  try {
    if (input.action === "reserve") {
      const context = await getContext(repository.repoRoot).catch(() => ({ status: "unreadable" }));
      ctx.localFamilies = context.status === "ok" ? context.release_families : null;
    }
    return await OPERATIONS[input.action](ctx);
  } catch {
    return githubUnavailable(input.action);
  }
}
