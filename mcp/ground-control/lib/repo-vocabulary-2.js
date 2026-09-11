// Extracted from lib.js (issue #1355).
//
// lib.js had reached 20,634 lines against the repo's 500-LOC limit
// (docs/CODING_STANDARDS.md, Sonar S104). It contained no mutual recursion, so it was
// split along its own dependency layering. lib.js remains the barrel every caller imports.

import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { readAbsoluteTextFile } from "./api-requirements.js";
import { parseGroundControlYaml } from "./ground-control-config.js";
import { ensureGitRepo } from "./grc-legacy-compat-4.js";
import { assertRealpathInRepo } from "./repo-context-2.js";
import { resolveRepoRelativePath } from "./repo-context.js";
import { buildSuggestedGroundControlYaml, resolveWorkflowRouteFromConfig } from "./runtime-primitives.js";

export async function getRepoGroundControlContext(repoPath) {
  const repoRoot = await ensureGitRepo(repoPath);
  const configPath = join(repoRoot, ".ground-control.yaml");

  let yamlText;
  try {
    yamlText = readAbsoluteTextFile(configPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        repo_path: repoRoot,
        config_path: configPath,
        status: "missing_ground_control_yaml",
        project: null,
        errors: [
          ".ground-control.yaml was not found at the repository root. Create it with schema_version: 1 and project: <your-project-id> at minimum.",
        ],
        suggested_ground_control_yaml: buildSuggestedGroundControlYaml(),
      };
    }
    throw error;
  }

  const parseResult = parseGroundControlYaml(yamlText);
  if (!parseResult.ok) {
    return {
      repo_path: repoRoot,
      config_path: configPath,
      status: "invalid_ground_control_yaml",
      project: null,
      errors: parseResult.errors,
      suggested_ground_control_yaml: buildSuggestedGroundControlYaml(),
    };
  }

  // Canonical repo root for every containment check below. Resolved before the first path field is
  // validated, since plan_rules is read here and the docs fields are checked further down.
  let repoRootRealForDocs;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repoRoot from git rev-parse
    repoRootRealForDocs = realpathSync(repoRoot);
  } catch (error) {
    throw new Error(`failed to canonicalize repo root ${repoRoot}: ${error.message}`);
  }

  // Resolve the plan_rules file if referenced. Must stay inside the repo root — and unlike every
  // other path field here, that was only ever a comment: the raw value went straight into join(),
  // so `../../../etc/passwd` escaped and its contents came back in the context response. The file
  // is read and returned, so this is an arbitrary host-file read driven by repository content, which
  // is attacker-controlled whenever the workflow runs against an untrusted branch. Both checks the
  // sibling fields already use apply: lexical containment, then realpath containment for symlinks.
  const { rules } = parseResult.value;
  let planRulesContent = null;
  if (rules.plan_rules_path) {
    const resolvedRules = resolveRepoRelativePath(repoRoot, rules.plan_rules_path, "rules.plan_rules");
    if (!resolvedRules.ok) {
      return {
        repo_path: repoRoot,
        config_path: configPath,
        status: "invalid_ground_control_yaml",
        project: null,
        errors: [resolvedRules.error],
        suggested_ground_control_yaml: buildSuggestedGroundControlYaml(),
      };
    }
    const rulesContainment = assertRealpathInRepo(repoRootRealForDocs, resolvedRules.abs, "rules.plan_rules");
    if (!rulesContainment.ok) {
      return {
        repo_path: repoRoot,
        config_path: configPath,
        status: "invalid_ground_control_yaml",
        project: null,
        errors: [rulesContainment.error],
        suggested_ground_control_yaml: buildSuggestedGroundControlYaml(),
      };
    }
    const absRulesPath = resolvedRules.abs;
    try {
      planRulesContent = readAbsoluteTextFile(absRulesPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          repo_path: repoRoot,
          config_path: configPath,
          status: "invalid_ground_control_yaml",
          project: null,
          errors: [
            `rules.plan_rules references ${rules.plan_rules_path} which does not exist`,
          ],
          suggested_ground_control_yaml: buildSuggestedGroundControlYaml(),
        };
      }
      throw error;
    }
  }

  const knowledgeBlockResult = resolveKnowledgeBlock(repoRoot, parseResult.value.knowledge);
  if (!knowledgeBlockResult.ok) {
    return {
      repo_path: repoRoot,
      config_path: configPath,
      status: "invalid_ground_control_yaml",
      project: null,
      errors: knowledgeBlockResult.errors,
      suggested_ground_control_yaml: buildSuggestedGroundControlYaml(),
    };
  }

  // Validate docs.* and example_paths.* path-valued fields are repo-relative
  // and don't escape the repo root. ADR-027 requires this so a malicious
  // .ground-control.yaml can't use docs.knowledge_base or example_paths.source
  // to point an agent at /etc/passwd or ../parent-repo/secrets. Lexical check
  // first (resolveRepoRelativePath), then realpath containment for paths the
  // agent will actually open (the docs.* set; example_paths.* are illustrative
  // strings the skill renders into prose, no on-disk reads).
  const docs = parseResult.value.docs;
  const docsPathErrors = [];
  for (const field of ["adr_dir", "architecture_overview", "coding_standards", "workflow_reference", "knowledge_base"]) {
    const v = docs[field];
    if (v == null) continue;
    const r = resolveRepoRelativePath(repoRoot, v, `docs.${field}`);
    if (!r.ok) {
      docsPathErrors.push(r.error);
      continue;
    }
    // Realpath containment: catches symlink escapes that lexical resolution
    // alone cannot. Skipped for paths that don't yet exist (the helper walks
    // up to the nearest existing ancestor on ENOENT).
    const real = assertRealpathInRepo(repoRootRealForDocs, r.abs, `docs.${field}`);
    if (!real.ok) docsPathErrors.push(real.error);
  }
  const examplePaths = parseResult.value.example_paths;
  for (const field of ["source", "test"]) {
    const v = examplePaths[field];
    if (v == null) continue;
    const r = resolveRepoRelativePath(repoRoot, v, `example_paths.${field}`);
    if (!r.ok) docsPathErrors.push(r.error);
  }
  // architecture.vocabulary path-valued entries: same containment rules as
  // docs.* (lexical resolve + realpath containment). example_path on patterns
  // and path on canonical_helpers are repo-relative documentation pointers
  // that may be opened by reviewers; both classes of escape (lexical and
  // symlink) must be caught here so a malicious .ground-control.yaml cannot
  // point a reviewer at /etc/passwd via an example_path.
  const architecture = parseResult.value.architecture;
  if (architecture && architecture.vocabulary) {
    const v = architecture.vocabulary;
    (v.patterns || []).forEach((entry, i) => {
      if (entry.example_path == null) return;
      const field = `architecture.vocabulary.patterns[${i}].example_path`;
      const r = resolveRepoRelativePath(repoRoot, entry.example_path, field);
      if (!r.ok) {
        docsPathErrors.push(r.error);
        return;
      }
      const real = assertRealpathInRepo(repoRootRealForDocs, r.abs, field);
      if (!real.ok) docsPathErrors.push(real.error);
    });
    (v.canonical_helpers || []).forEach((entry, i) => {
      if (entry.path == null) return;
      const field = `architecture.vocabulary.canonical_helpers[${i}].path`;
      const r = resolveRepoRelativePath(repoRoot, entry.path, field);
      if (!r.ok) {
        docsPathErrors.push(r.error);
        return;
      }
      const real = assertRealpathInRepo(repoRootRealForDocs, r.abs, field);
      if (!real.ok) docsPathErrors.push(real.error);
    });
  }
  if (docsPathErrors.length) {
    return {
      repo_path: repoRoot,
      config_path: configPath,
      status: "invalid_ground_control_yaml",
      project: null,
      errors: docsPathErrors,
      suggested_ground_control_yaml: buildSuggestedGroundControlYaml(),
    };
  }

  return {
    repo_path: repoRoot,
    config_path: configPath,
    status: "ok",
    project: parseResult.value.project,
    github_repo: parseResult.value.github_repo,
    short_code: parseResult.value.short_code,
    workflow: parseResult.value.workflow,
    sonarcloud: parseResult.value.sonarcloud,
    rules: {
      plan_rules_path: rules.plan_rules_path,
      plan_rules_content: planRulesContent,
    },
    knowledge: knowledgeBlockResult.value,
    docs: parseResult.value.docs,
    example_paths: parseResult.value.example_paths,
    requirements: parseResult.value.requirements,
    cross_cutting_concerns: parseResult.value.cross_cutting_concerns,
    routing: parseResult.value.routing,
    architecture: parseResult.value.architecture,
    errors: [],
  };
}
export async function runResolveWorkflowRoute({ repoPath, stage, tier = null }) {
  let context;
  try {
    context = await getRepoGroundControlContext(repoPath);
  } catch (error) {
    return { ok: false, error: "routing_context_error", message: error.message };
  }
  if (context.status !== "ok") {
    return {
      ok: false,
      error: "routing_context_invalid",
      message: (context.errors || []).join("; ") || context.status,
      status: context.status,
    };
  }
  const route = resolveWorkflowRouteFromConfig({ routing: context.routing, stage, tier });
  return {
    ...route,
    repo_path: context.repo_path,
    config_path: context.config_path,
    project: context.project,
  };
}
function resolveKnowledgeBlock(repoRoot, knowledge) {
  if (knowledge == null) return { ok: true, value: null };

  // Canonicalize the repo root once; every containment check compares against
  // this canonical path so symlinks on either side cannot disagree. `repoRoot`
  // comes from `git rev-parse --show-toplevel` but may still traverse a
  // symlink on macOS or on bind-mounted checkouts, so always realpath it.
  let repoRootReal;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- repoRoot comes from git rev-parse --show-toplevel
    repoRootReal = realpathSync(repoRoot);
  } catch (error) {
    throw new Error(`failed to canonicalize repo root ${repoRoot}: ${error.message}`);
  }

  const dirResolved = resolveRepoRelativePath(repoRoot, knowledge.dir, "knowledge.dir");
  if (!dirResolved.ok) return { ok: false, errors: [dirResolved.error] };

  const rawSchema = knowledge.schema ?? `${dirResolved.rel}/SCHEMA.md`;
  const rawInbox = knowledge.inbox ?? `${dirResolved.rel}/inbox`;

  const schemaResolved = resolveRepoRelativePath(repoRoot, rawSchema, "knowledge.schema");
  if (!schemaResolved.ok) return { ok: false, errors: [schemaResolved.error] };

  const inboxResolved = resolveRepoRelativePath(repoRoot, rawInbox, "knowledge.inbox");
  if (!inboxResolved.ok) return { ok: false, errors: [inboxResolved.error] };

  // Realpath containment: catches symlink escapes that the lexical check cannot.
  const dirReal = assertRealpathInRepo(repoRootReal, dirResolved.abs, "knowledge.dir");
  if (!dirReal.ok) return { ok: false, errors: [dirReal.error] };

  const schemaReal = assertRealpathInRepo(repoRootReal, schemaResolved.abs, "knowledge.schema");
  if (!schemaReal.ok) return { ok: false, errors: [schemaReal.error] };

  const inboxReal = assertRealpathInRepo(repoRootReal, inboxResolved.abs, "knowledge.inbox");
  if (!inboxReal.ok) return { ok: false, errors: [inboxReal.error] };

  // Filesystem existence: dir and schema must exist. Inbox is created lazily.
  // We stat the canonical path so the directory/file-type checks cannot be
  // spoofed by a symlink whose target is a different kind of inode.
  let dirStat;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dirReal.canonical is contained in the canonical repo root
    dirStat = statSync(dirReal.canonical);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ok: false,
        errors: [`knowledge.dir references ${dirResolved.rel} which does not exist`],
      };
    }
    throw error;
  }
  if (!dirStat.isDirectory()) {
    return {
      ok: false,
      errors: [`knowledge.dir references ${dirResolved.rel} which is not a directory`],
    };
  }

  let schemaStat;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- schemaReal.canonical is contained in the canonical repo root
    schemaStat = statSync(schemaReal.canonical);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ok: false,
        errors: [`knowledge.schema references ${schemaResolved.rel} which does not exist (expected a SCHEMA.md file)`],
      };
    }
    throw error;
  }
  if (!schemaStat.isFile()) {
    return {
      ok: false,
      errors: [`knowledge.schema references ${schemaResolved.rel} which is not a file`],
    };
  }

  // The inbox directory is lazily created, so its existence is optional in
  // this slice — but when it DOES exist it must be a directory. An inbox
  // configured to point at a regular file (e.g. `docs/knowledge/SCHEMA.md`)
  // would pass the lexical and realpath checks but break every downstream
  // capture flow that writes files under the inbox. Catch the misconfig
  // here where the error message can name the offending field.
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inboxReal.canonical is contained in the canonical repo root
    const inboxStat = statSync(inboxReal.canonical);
    if (!inboxStat.isDirectory()) {
      return {
        ok: false,
        errors: [`knowledge.inbox references ${inboxResolved.rel} which is not a directory`],
      };
    }
  } catch (error) {
    // ENOENT is the expected happy-path state until a later slice creates
    // the inbox on first capture. Anything else (permissions, I/O, ENOTDIR
    // on a broken symlink target) is a configuration error worth surfacing.
    if (error.code !== "ENOENT") {
      return {
        ok: false,
        errors: [`knowledge.inbox references ${inboxResolved.rel} which cannot be examined (${error.code})`],
      };
    }
  }

  return {
    ok: true,
    value: {
      dir: dirResolved.rel,
      schema: schemaResolved.rel,
      inbox: inboxResolved.rel,
    },
  };
}
