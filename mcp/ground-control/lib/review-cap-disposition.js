// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

export const REVIEW_DISPOSITIONS = Object.freeze([
  "proceed",
  "one_more_cycle",
  "escalate_to_human",
]);
export const REVIEW_DISPOSITION_NEXT_ACTION = Object.freeze({
  proceed: "proceed_to_phase_c",
  one_more_cycle: "reinvoke_cycle_with_auto_override",
  escalate_to_human: "ask_over_cap_or_proceed",
});
export const REVIEW_DISPOSITION_HIGH_RISK_SURFACES = Object.freeze([
  "migration",
  "controller",
  "mcp_tool",
  "config_parser",
  "public_api",
]);
const REVIEW_AUTO_DISPOSITION_SCHEMA = "gc.implement.review-auto-disposition/v1";
const REVIEW_AUTO_DISPOSITION_MARKER_PREFIX = "<!-- gc:review-auto-disposition";
const REVIEW_AUTO_DISPOSITION_MARKER_RE =
  /<!--\s*gc:review-auto-disposition(?!-data)\s+([^]*?)-->/g;
const REVIEW_AUTO_DISPOSITION_DATA_RE =
  /<!--\s*gc:review-auto-disposition-data\s+(\{[^]*?\})\s*-->/g;
function _parseMarkerAttrs(attrText) {
  const attrs = {};
  if (typeof attrText !== "string") return attrs;
  for (const m of attrText.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}
function isNumstatCount(column) {
  // `-` is git's binary-file placeholder; anything else must be a decimal count.
  return column === "-" || Number.isInteger(Number.parseInt(column, 10));
}
export function parseNumstatManifest(manifest) {
  const result = { files_changed: 0, lines_added: 0, lines_deleted: 0 };
  if (typeof manifest !== "string") return result;
  const seen = new Set();
  for (const rawLine of manifest.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line === "(none)" || line === "(no files changed)") continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10);
    const deleted = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10);
    if (!Number.isInteger(added) || !Number.isInteger(deleted)) continue;
    const path = parts.slice(2).join("\t");
    result.lines_added += added;
    result.lines_deleted += deleted;
    if (path && !seen.has(path)) {
      seen.add(path);
      result.files_changed += 1;
    }
  }
  return result;
}
export function parseChangedPathsFromManifest(manifest) {
  const paths = [];
  const seen = new Set();
  if (typeof manifest !== "string") return paths;
  for (const rawLine of manifest.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line === "(none)" || line === "(no files changed)") continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    // Same row grammar as parseNumstatManifest: only a numstat row is data.
    // The manifest also carries an additive `--name-status` block (#1557), and
    // without this check a rename row (`R100\told\tnew`) would be read as a
    // changed path and reach classifyChangedSurface, which throws on a path it
    // cannot resolve. A status column is never an integer.
    if (!isNumstatCount(parts[0]) || !isNumstatCount(parts[1])) continue;
    const path = parts.slice(2).join("\t");
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}
const REVIEW_DISPOSITION_SECURITY_SHAPE_RE = /\bsecurity\b|\bvuln|injection|secret|\bauthn?\b|\bauthz\b|authoriz|cwe|xss|ssrf|\bcsrf\b/i;
export function summarizeFindingsForDisposition(findingsSummary) {
  // `known` records whether the caller actually supplied a findings summary. A
  // null/absent summary must NOT be silently treated as "zero findings": the
  // disposition fires at the cap boundary precisely because findings were
  // present, so a missing signal is unknown-risk, not low-risk. scoreDisposition
  // refuses the proceed fast-path when findings are unknown (fail-safe).
  const known = findingsSummary != null && typeof findingsSummary === "object";
  const fs = known ? findingsSummary : {};
  const oneOff = Number.isInteger(fs.one_off_count) ? fs.one_off_count : 0;
  const classCount = Number.isInteger(fs.class_count) ? fs.class_count : 0;
  const cats = Array.isArray(fs.top_categories)
    ? fs.top_categories
    : Array.isArray(fs.categories)
      ? fs.categories
      : [];
  const hasSecurity =
    fs.has_security_finding === true ||
    cats.some((c) => {
      const shape = typeof c === "string" ? c : typeof c?.shape === "string" ? c.shape : "";
      return REVIEW_DISPOSITION_SECURITY_SHAPE_RE.test(shape);
    });
  return { one_off_count: oneOff, class_count: classCount, has_security_finding: hasSecurity, known };
}
export function _isHighRiskSnapshot(snapshot) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  const findings = s.findings && typeof s.findings === "object" ? s.findings : {};
  const surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
  return (
    findings.has_security_finding === true ||
    surfaces.some((c) => REVIEW_DISPOSITION_HIGH_RISK_SURFACES.includes(c))
  );
}
export function scoreDisposition(signalsSnapshot, config) {
  const s = signalsSnapshot && typeof signalsSnapshot === "object" ? signalsSnapshot : {};
  const cfg = config && typeof config === "object" ? config : {};
  const maxAuto = Number.isInteger(cfg.max_auto_overrides) ? cfg.max_auto_overrides : 1;
  const priorAutoOverrides = Number.isInteger(s.prior_auto_overrides) ? s.prior_auto_overrides : 0;
  const diff = s.diff && typeof s.diff === "object" ? s.diff : {};
  const filesChanged = Number.isInteger(diff.files_changed) ? diff.files_changed : 0;
  const linesAdded = Number.isInteger(diff.lines_added) ? diff.lines_added : 0;
  const linesDeleted = Number.isInteger(diff.lines_deleted) ? diff.lines_deleted : 0;
  const surfaces = Array.isArray(s.surfaces) ? s.surfaces : [];
  const findings = s.findings && typeof s.findings === "object" ? s.findings : {};
  const oneOff = Number.isInteger(findings.one_off_count) ? findings.one_off_count : 0;
  const classCount = Number.isInteger(findings.class_count) ? findings.class_count : 0;
  const hasSecurityFinding = findings.has_security_finding === true;
  // Findings shape is "known" unless explicitly flagged absent. A missing
  // findings signal (the MCP path with no findings_summary) is treated as
  // unknown-risk, which forecloses the proceed fast-path below.
  const findingsKnown = findings.known !== false;
  const reviewer = s.reviewer;

  const hasHighRiskSurface = surfaces.some((c) => REVIEW_DISPOSITION_HIGH_RISK_SURFACES.includes(c));
  const highRisk = hasSecurityFinding || hasHighRiskSurface;

  // Weights recalibrated (ADR-089 §2): with the GRC-derived 0.5 contribution
  // gone, the two remaining boolean signals are up-weighted (0.3->0.55,
  // 0.2->0.4) and the diff-size cap is raised (0.2->0.25) so a change with
  // both signals plus a non-trivial diff still saturates risk_score at 1, the
  // same ceiling a GRC-flagged change used to reach.
  let riskScore = 0;
  if (hasSecurityFinding) riskScore += 0.55;
  if (hasHighRiskSurface) riskScore += 0.4;
  riskScore += Math.min(0.25, (linesAdded + linesDeleted) / 1000);
  riskScore += Math.min(0.2, classCount * 0.1);
  // Diff transport (issue #1414). A change whose diff did not fit one prompt
  // was reviewed as slices, so each reviewer judged it with less cross-file
  // context than a fully inlined review — and an unknown mode is not evidence
  // of full coverage either. Both carry a small, bounded penalty; an absent
  // field stays neutral so snapshots built before this signal existed score
  // exactly as they did.
  if (typeof s.diff_mode === "string" && s.diff_mode !== "inline") riskScore += 0.15;
  riskScore = Math.min(1, Math.round(riskScore * 1000) / 1000);

  const mk = (disposition, decidedBy, rationale) => ({
    disposition,
    next_action: REVIEW_DISPOSITION_NEXT_ACTION[disposition],
    rationale,
    decided_by: decidedBy,
    risk_score: riskScore,
  });

  // 1. Hard ceiling.
  if (priorAutoOverrides >= maxAuto) {
    if (highRisk) {
      return mk("escalate_to_human", "ceiling", "auto-override ceiling reached and change is high-risk; escalating to a human");
    }
    return mk("proceed", "ceiling", "auto-override ceiling reached; residual risk low, proceeding");
  }

  // 2. Fast-paths.
  if (reviewer === "codex" && highRisk) {
    return mk("one_more_cycle", "fast_path", "codex review on a high-risk surface warrants one more cycle");
  }
  // Tiny-diff auto-proceed bounds tightened (ADR-089 §2: lines 40->25,
  // files 3->2, allowed one-offs 2->1) to compensate for the removed GRC
  // signal — fewer independent risk inputs means the automatic-proceed fast
  // path must demand more confidence before firing.
  const tinyDiff = linesAdded + linesDeleted <= 25 && filesChanged <= 2;
  if (tinyDiff && !highRisk && findingsKnown && classCount === 0 && oneOff <= 1) {
    return mk("proceed", "fast_path", "small low-risk diff with no class findings; proceeding");
  }

  // 3. Gray zone — caller resolves via judge or safe default. A change whose
  // findings shape is unknown also lands here rather than fast-pathing to
  // proceed, so a dropped findings signal can never launder a class finding
  // into an automatic proceed.
  if (!findingsKnown) {
    return mk("escalate_to_human", "judge_needed", "findings shape unknown; cannot auto-proceed — judge or human decision required");
  }
  return mk("escalate_to_human", "judge_needed", "gray-zone change; judge or human decision required");
}
export function parseReviewAutoDispositionMarkers(commentBodies, issueNumber, reviewer) {
  const markers = [];
  let auto_override_grants = 0;
  if (!Array.isArray(commentBodies)) return { markers, auto_override_grants };
  for (const body of commentBodies) {
    if (typeof body !== "string") continue;
    const dataBlocks = [];
    REVIEW_AUTO_DISPOSITION_DATA_RE.lastIndex = 0;
    for (const dm of body.matchAll(REVIEW_AUTO_DISPOSITION_DATA_RE)) {
      try {
        dataBlocks.push(JSON.parse(dm[1]));
      } catch {
        dataBlocks.push(null);
      }
    }
    let idx = 0;
    REVIEW_AUTO_DISPOSITION_MARKER_RE.lastIndex = 0;
    for (const m of body.matchAll(REVIEW_AUTO_DISPOSITION_MARKER_RE)) {
      const attrs = _parseMarkerAttrs(m[1]);
      const markerIssue = Number.parseInt(attrs.issue, 10);
      const data = dataBlocks[idx] ?? null;
      idx += 1;
      if (markerIssue !== issueNumber) continue;
      if (typeof reviewer === "string" && attrs.reviewer !== reviewer) continue;
      const disposition =
        attrs.disposition ?? (data && typeof data.disposition === "string" ? data.disposition : null);
      const grant = attrs.grant != null ? Number.parseInt(attrs.grant, 10) : null;
      markers.push({
        issue: markerIssue,
        reviewer: attrs.reviewer ?? null,
        disposition,
        grant: Number.isInteger(grant) ? grant : null,
        data,
      });
      if (disposition === "one_more_cycle") auto_override_grants += 1;
    }
  }
  return { markers, auto_override_grants };
}
export function buildReviewAutoDispositionRecord({
  issueNumber,
  reviewer,
  cycle,
  cap,
  mode,
  disposition,
  rationale,
  signalsSnapshot,
  grantNumber,
}) {
  const schema = REVIEW_AUTO_DISPOSITION_SCHEMA;
  const grantAttr = disposition === "one_more_cycle" ? "true" : "false";
  const safeRationale = typeof rationale === "string" ? rationale : "";
  // The issuance mode is persisted in the durable record so a grant minted in
  // shadow mode can never be promoted to authorizing by later flipping the repo
  // to authoritative — the verifier checks the marker's own recorded mode, not
  // just the current config. `cap` is the server-derived effective reviewer cap
  // (not a caller-supplied value), so the grant is bound to the real boundary.
  const issuedMode = mode === "authoritative" ? "authoritative" : "shadow";
  const data = {
    schema,
    disposition,
    reviewer,
    cycle,
    cap,
    mode: issuedMode,
    grant: Number.isInteger(grantNumber) ? grantNumber : null,
    signals_snapshot: signalsSnapshot ?? null,
  };
  const marker =
    `${REVIEW_AUTO_DISPOSITION_MARKER_PREFIX} issue="${issueNumber}" reviewer="${reviewer}" ` +
    `schema="${schema}" disposition="${disposition}" mode="${issuedMode}" grant="${grantAttr}" -->`;
  const dataBlock = `<!-- gc:review-auto-disposition-data ${JSON.stringify(data)} -->`;
  return [
    marker,
    "",
    `## gc_review_cap_disposition — issue #${issueNumber} (${reviewer}, cycle ${cycle} of ${cap})`,
    "",
    `**Disposition:** ${disposition}  `,
    `**Auto-override grant #:** ${Number.isInteger(grantNumber) ? grantNumber : "n/a"}  `,
    `**Rationale:** ${safeRationale}`,
    "",
    "Posted by the MCP server to record the review-cap auto-disposition. Do not edit or delete — " +
      "the cycle wrappers read this marker to verify an over-cap auto-grant before running a cycle.",
    "",
    dataBlock,
  ].join("\n");
}
export function buildDispositionJudgePrompt({ signalsSnapshot, reviewer, issueNumber, cycle, cap }) {
  return [
    "You are an automated review-cap disposition judge for a pre-push code review loop.",
    `Reviewer: ${reviewer}. Issue: #${issueNumber}. Cycle ${cycle} of ${cap}.`,
    "",
    "A deterministic scorer could not decide whether to proceed, run one more review cycle, or",
    "escalate to a human. Decide using the signals snapshot below. Prefer escalate_to_human when",
    "in doubt — an automatic over-cap cycle is a privilege, not a default.",
    "",
    "Signals snapshot (JSON):",
    JSON.stringify(signalsSnapshot ?? {}, null, 2),
    "",
    "Return JSON matching the provided schema: { disposition: one of",
    `${REVIEW_DISPOSITIONS.join(" | ")}, rationale: a one-line justification }.`,
  ].join("\n");
}
export const REVIEW_AUTO_DISPOSITION_JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["disposition", "rationale"],
  properties: {
    disposition: { type: "string", enum: [...REVIEW_DISPOSITIONS] },
    rationale: { type: "string", minLength: 1, maxLength: 400 },
  },
};
export function parseDispositionJudgeOutput(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    return null;
  }
  let payload = outer;
  if (outer && typeof outer.result === "string") {
    try {
      payload = JSON.parse(outer.result);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload.disposition !== "string" || !REVIEW_DISPOSITIONS.includes(payload.disposition)) {
    return null;
  }
  return {
    disposition: payload.disposition,
    rationale: typeof payload.rationale === "string" ? payload.rationale : null,
  };
}
export function _emptyReviewDispositionConfigForRunner() {
  return { enabled: false, mode: "shadow", max_auto_overrides: 1, judge: { enabled: false, model: null } };
}
export function evaluateAutoDispositionGrant({ config, trustedLogin, authored, issueNumber, reviewer, cyclesRun, effectiveCap }) {
  if (config?.enabled !== true) {
    return { authorized: false, reason: "review_disposition_disabled" };
  }
  if (config.mode !== "authoritative") {
    return { authorized: false, reason: "review_disposition_mode_not_authoritative" };
  }
  if (typeof trustedLogin !== "string" || trustedLogin.trim() === "") {
    return { authorized: false, reason: "trusted_poster_unresolved" };
  }
  if (!Number.isInteger(effectiveCap) || effectiveCap <= 0) {
    return { authorized: false, reason: "effective_cap_unresolved" };
  }
  const maxAuto = Number.isInteger(config.max_auto_overrides) ? config.max_auto_overrides : 1;
  const list = Array.isArray(authored) ? authored : [];
  const trustedBodies = list
    .filter((c) => c && c.authorLogin === trustedLogin && typeof c.body === "string")
    .map((c) => c.body);
  const { markers, auto_override_grants } = parseReviewAutoDispositionMarkers(trustedBodies, issueNumber, reviewer);
  const relevant = markers.filter((m) => m.reviewer === reviewer && m.issue === issueNumber);
  const latest = relevant.length > 0 ? relevant[relevant.length - 1] : null;
  if (!latest || latest.disposition !== "one_more_cycle") {
    return { authorized: false, reason: latest ? "latest_disposition_not_one_more_cycle" : "no_auto_disposition_grant" };
  }
  // The grant's OWN recorded issuance mode must be authoritative — not just the
  // current config — so a marker minted in shadow mode is never consumable.
  if (!latest.data || latest.data.mode !== "authoritative") {
    return { authorized: false, reason: "grant_not_authoritative_mode" };
  }
  if (auto_override_grants > maxAuto) {
    return { authorized: false, reason: "auto_override_ceiling_exceeded" };
  }
  const capBoundary = latest.data && Number.isInteger(latest.data.cap) ? latest.data.cap : null;
  if (!Number.isInteger(capBoundary) || capBoundary <= 0) {
    return { authorized: false, reason: "grant_missing_cap_boundary" };
  }
  // The grant must bind to the SAME boundary the server enforces now.
  if (capBoundary !== effectiveCap) {
    return { authorized: false, reason: "grant_cap_boundary_mismatch" };
  }
  const runs = Number.isInteger(cyclesRun) ? cyclesRun : 0;
  const overCapCyclesRun = Math.max(0, runs - capBoundary);
  if (overCapCyclesRun >= auto_override_grants) {
    return { authorized: false, reason: "auto_grant_already_consumed" };
  }
  return { authorized: true, grant_number: auto_override_grants };
}
