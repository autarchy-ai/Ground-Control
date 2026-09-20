import { realpathSync } from "node:fs";
import {
  assertSafeImplementCheckoutConfiguration,
  authorizeImplementRepoRoot,
  ensureGitRepo,
  resolveMcpLaunchWorkspaceAuthorization,
} from "./grc-legacy-compat-4.js";
import {
  asyncJobInputFingerprint,
  startAsyncJob,
} from "./async-job-registry.js";

const REVIEW_CYCLE_KINDS = Object.freeze({
  codex: "codex_review_cycle",
});

function transportFailure(error, message) {
  return { ok: false, error, message };
}

export async function runReviewCycleTransport(input, overrides = {}) {
  if (input?.asyncMode === false) {
    return transportFailure(
      "review_cycle_async_required",
      "Review-cycle tools are async-only; omit async or pass async=true and await gc_codex_job.",
    );
  }
  const kind = REVIEW_CYCLE_KINDS[input?.reviewer];
  if (
    kind == null
    || !Number.isInteger(input?.issueNumber)
    || input.issueNumber <= 0
    || typeof input?.runCycle !== "function"
  ) {
    return transportFailure(
      "review_cycle_transport_input_invalid",
      "reviewer, positive issue number, and cycle executor are required.",
    );
  }

  const {
    ensureRepo = ensureGitRepo,
    canonicalizeRepoPath = realpathSync,
    workspaceAuthorizationResolver = resolveMcpLaunchWorkspaceAuthorization,
    authorizeRepo = authorizeImplementRepoRoot,
    assertSafeCheckout = assertSafeImplementCheckoutConfiguration,
    startJob = startAsyncJob,
  } = overrides;

  let repoRoot;
  try {
    repoRoot = canonicalizeRepoPath(await ensureRepo(input.repoPath));
  } catch {
    return transportFailure(
      "review_cycle_repo_invalid",
      "repo_path must resolve to the authorized canonical Git checkout.",
    );
  }

  const authorization = await authorizeRepo(repoRoot, workspaceAuthorizationResolver);
  if (!authorization?.ok) return authorization;
  try {
    await assertSafeCheckout(repoRoot);
  } catch {
    return transportFailure(
      "review_cycle_repo_configuration_unsafe",
      "The checkout has unsafe local Git configuration for review execution.",
    );
  }

  const cycleInput = { ...input.cycleInput, repoPath: repoRoot };
  const scope = `review_cycle:${repoRoot}:issue:${input.issueNumber}:reviewer:${input.reviewer}`;
  return startJob(
    kind,
    (signal) => input.runCycle({ ...cycleInput, signal }),
    {
      idempotencyKey: input.idempotencyKey,
      idempotencyNamespace: scope,
      fingerprint: asyncJobInputFingerprint(cycleInput),
      executionScope: scope,
      singleFlight: true,
      cancellable: false,
    },
  );
}
