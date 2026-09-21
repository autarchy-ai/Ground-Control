// The `.ground-control.yaml` repository context parser (ADR-027).
//
// Lifted out of a module the 500-LOC split had named mechanically (issue #1355). The
// documentation-coverage gate anchors its `config_parser` surface on the file that defines this
// parser, and an arbitrary name gives that anchor nothing durable to point at: when the parser
// moved, the surface kept matching the file it had left and the gate stopped asking for
// documentation on the parser at all. A module named for its contract is the anchor.

import { load as parseYaml } from "js-yaml";
import { normalizeCrossCuttingConcernsConfig, normalizeExamplePathsConfig, normalizeKnowledgeConfig, normalizePhaseEConfig, normalizeRequirementsConfig } from "./constants.js";
import { normalizeRoutingConfig, normalizeWorkflowConfig } from "./repo-context-2.js";
import { SUPPORTED_GROUND_CONTROL_SCHEMA_VERSIONS, normalizeDocsConfig, normalizeRulesConfig, normalizeSonarcloudConfig } from "./repo-context.js";
import { normalizeReleaseFamiliesConfig } from "./release-identity-config.js";
import { normalizeArchitectureConfig } from "./repo-vocabulary.js";
import { GITHUB_REPO_RE, GROUND_CONTROL_PROJECT_RE } from "./runtime-primitives.js";

export function parseGroundControlYaml(yamlText) {
  let parsed;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    return { ok: false, errors: [`Could not parse .ground-control.yaml: ${error.message}`] };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: [".ground-control.yaml root must be a mapping"] };
  }

  const errors = [];
  const allowedTop = [
    "schema_version",
    "project",
    "github_repo",
    "workflow",
    "sonarcloud",
    "rules",
    "knowledge",
    "docs",
    "example_paths",
    "requirements",
    "cross_cutting_concerns",
    "routing",
    "telemetry",
    "architecture",
    "short_code",
    "release_families",
    "phase_e",
  ];
  // `grc` is intentionally NOT in allowedTop's rejection path: a legacy
  // `grc.*` block from a consumer repo's .ground-control.yaml (ADR-057/058,
  // retired by ADR-089) is tolerated and ignored rather than rejected, so an
  // otherwise-valid repo config does not break. Its content is never
  // validated, parsed, or included in the returned context — this is a
  // read-and-discard compatibility allowance, not a second active config
  // surface.
  for (const key of Object.keys(parsed)) {
    if (key === "grc") continue;
    if (!allowedTop.includes(key)) {
      errors.push(`unknown top-level key '${key}'`);
    }
  }

  const schemaVersion = parsed.schema_version;
  if (!SUPPORTED_GROUND_CONTROL_SCHEMA_VERSIONS.includes(schemaVersion)) {
    errors.push(
      `schema_version must be one of ${SUPPORTED_GROUND_CONTROL_SCHEMA_VERSIONS.join(", ")} (got ${JSON.stringify(schemaVersion)})`,
    );
  }

  const project = parsed.project;
  if (typeof project !== "string" || project.trim() === "") {
    errors.push("project is required and must be a non-empty string");
  } else if (!GROUND_CONTROL_PROJECT_RE.test(project)) {
    errors.push(
      "project must be a lowercase identifier using letters, numbers, and hyphens only",
    );
  }

  let githubRepo = null;
  if (parsed.github_repo != null) {
    if (typeof parsed.github_repo !== "string" || !GITHUB_REPO_RE.test(parsed.github_repo.trim())) {
      // github_repo is a validated identity assertion (GC-P026): require the
      // 'owner/repo' shape, not merely non-empty, so a malformed value is
      // rejected at parse time rather than flowing into a `gh --repo` argument.
      errors.push("github_repo must be a non-empty 'owner/repo' string when set");
    } else {
      githubRepo = parsed.github_repo.trim();
    }
  }

  let shortCode = null;
  if (parsed.short_code != null) {
    if (
      typeof parsed.short_code !== "string" ||
      !/^[A-Z][A-Z0-9]{0,7}$/.test(parsed.short_code)
    ) {
      errors.push(
        'short_code must match ^[A-Z][A-Z0-9]{0,7}$ (1-8 uppercase alphanumeric characters, e.g. "GC"), if provided',
      );
    } else {
      shortCode = parsed.short_code;
    }
  }

  const workflowResult = normalizeWorkflowConfig(parsed.workflow);
  if (!workflowResult.ok) errors.push(...workflowResult.errors);

  const sonarResult = normalizeSonarcloudConfig(parsed.sonarcloud);
  if (!sonarResult.ok) errors.push(...sonarResult.errors);

  const rulesResult = normalizeRulesConfig(parsed.rules);
  if (!rulesResult.ok) errors.push(...rulesResult.errors);

  const knowledgeResult = normalizeKnowledgeConfig(parsed.knowledge);
  if (!knowledgeResult.ok) errors.push(...knowledgeResult.errors);

  const docsResult = normalizeDocsConfig(parsed.docs);
  if (!docsResult.ok) errors.push(...docsResult.errors);

  const examplePathsResult = normalizeExamplePathsConfig(parsed.example_paths);
  if (!examplePathsResult.ok) errors.push(...examplePathsResult.errors);

  const requirementsResult = normalizeRequirementsConfig(parsed.requirements);
  if (!requirementsResult.ok) errors.push(...requirementsResult.errors);

  const crossCuttingResult = normalizeCrossCuttingConcernsConfig(parsed.cross_cutting_concerns);
  if (!crossCuttingResult.ok) errors.push(...crossCuttingResult.errors);

  const routingResult = normalizeRoutingConfig(parsed.routing);
  if (!routingResult.ok) errors.push(...routingResult.errors);

  const architectureResult = normalizeArchitectureConfig(parsed.architecture);
  if (!architectureResult.ok) errors.push(...architectureResult.errors);

  const releaseFamiliesResult = normalizeReleaseFamiliesConfig(parsed.release_families, {
    defaultBaseBranch: workflowResult.value?.base_branch ?? "dev",
  });
  if (!releaseFamiliesResult.ok) errors.push(...releaseFamiliesResult.errors);

  const phaseEResult = normalizePhaseEConfig(parsed.phase_e);
  if (!phaseEResult.ok) errors.push(...phaseEResult.errors);

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      project,
      github_repo: githubRepo,
      short_code: shortCode,
      workflow: workflowResult.value,
      sonarcloud: sonarResult.value,
      rules: {
        plan_rules_path: rulesResult.value.plan_rules_path,
      },
      knowledge: knowledgeResult.value,
      docs: docsResult.value,
      example_paths: examplePathsResult.value,
      requirements: requirementsResult.value,
      cross_cutting_concerns: crossCuttingResult.value,
      routing: routingResult.value,
      architecture: architectureResult.value,
      release_families: releaseFamiliesResult.value,
      phase_e: phaseEResult.value,
    },
  };
}
