// `grndctl finalize-merged-pr` — the transport the merged-pull-request job runs (#1671).
//
// The GitHub Actions workflow carries no `gh` logic, no marker parser, and no completion
// reconstruction: it passes the event's pull-request number to this verb and nothing else.
// Everything that decides anything lives in the library function, where it is unit-testable
// without a runner.
//
// `GITHUB_RUN_ID` is read here rather than passed on the command line: it is the job's own
// identity, and it travels to the final-report marker as provenance the close gate verifies
// against the Actions API. A forged value simply fails that verification.

import { runAutomatedPhaseE } from "../implement/phase-e-automation.js";

const USAGE = `usage: grndctl finalize-merged-pr --pr <number>

Finish Phase E for an already-merged Ground Control delivery pull request. Run it from the
repository checkout. Exits 0 when the delivery was finalized or the pull request is not a
Ground Control delivery, and non-zero when finalization failed.
`;

export function parseFinalizeArgs(argv) {
  let pr = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pr" || arg === "--pr-number") {
      pr = argv[i + 1];
      i += 1;
      continue;
    }
    const inline = /^--pr(?:-number)?=(.*)$/.exec(arg);
    if (inline) {
      pr = inline[1];
      continue;
    }
    return { ok: false, error: `unrecognized argument '${arg}'` };
  }
  const parsed = Number.parseInt(pr ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, error: "--pr must be a positive integer" };
  }
  return { ok: true, prNumber: parsed };
}

export async function runFinalizeMergedPrCli(argv, {
  cwd = process.cwd(),
  env = process.env,
  print = (line) => process.stdout.write(`${line}\n`),
  printError = (line) => process.stderr.write(`${line}\n`),
  finalize = runAutomatedPhaseE,
} = {}) {
  const args = parseFinalizeArgs(argv);
  if (!args.ok) {
    printError(args.error);
    printError(USAGE);
    return 2;
  }
  const runId = Number.parseInt(env.GITHUB_RUN_ID ?? "", 10);
  let result;
  try {
    result = await finalize({
      repoPath: cwd,
      prNumber: args.prNumber,
      automationRunId: Number.isInteger(runId) && runId > 0 ? runId : null,
    });
  } catch (error) {
    // An unexpected throw must still read as a failed finalization rather than an
    // unhandled rejection: the job has to go red, and its log has to say why without a
    // stack trace carrying whatever the thrower happened to attach.
    printError(`finalize-merged-pr failed: ${String(error?.message ?? error).slice(0, 600)}`);
    return 1;
  }
  print(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}
