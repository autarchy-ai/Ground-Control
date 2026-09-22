// The one completion-input mapping (issue #1671).
//
// It lived in implement/publish.js, where only the mechanical actions could reach it. The
// delivery-readiness record stores the tool-shaped completion input verbatim so a post-merge
// replay is literally "call the finalizer again with the recorded input" — and it has to
// validate exactly what it stores, which means mapping it the same way the finalizer will.
// A second mapping would be a duplicate DTO waiting to drift.

export function mapCompletion(args, phase) {
  const input = args.completion;
  return {
    repoPath: args.repoPath,
    issueNumber: args.issueNumber,
    prNumber: args.prNumber,
    requirements: (input.requirements ?? []).map((item) => ({
      uid: item.uid,
      title: item.title,
      status: item.status,
      statusIntent: item.status_intent,
      note: item.note,
    })),
    files: input.files,
    reviews: input.reviews,
    traceability: input.traceability,
    ciStatus: input.ci_status,
    sonarStatus: input.sonar_status,
    planCommentUrl: input.plan_comment_url,
    summary: input.summary,
    plainEnglishOutcome: input.plain_english_outcome,
    touchedFiles: input.touched_files,
    project: input.project,
    lane: args.lane ?? "implement",
    // Set only by the deterministic post-merge finalizer (issue #1671). It is provenance
    // the close gate VERIFIES against the Actions API, never authority on its own.
    automationRunId: args.automationRunId ?? null,
    phase,
  };
}
