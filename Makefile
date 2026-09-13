.PHONY: ground-control-mcp-install mcp-test mcp-lint docs graphify vale-install vale-lint \
       policy policy-tests hooks devmain ci-timings help

# Ground Control is the MCP server for the /implement workflow over repo-local
# files (issue #1500). Requirements live in docs/requirements/, ADRs in
# architecture/adrs/; there is no backend, database, or frontend. The MCP node
# test suite plus the repo policy and prose checks are the verification surface.

# --- MCP server ---

ground-control-mcp-install: ## Install dependencies for the repo-local Ground Control MCP server
	npm --prefix mcp/ground-control ci

mcp-test: ## Run the MCP server node test suite (primary test gate)
	npm --prefix mcp/ground-control test

mcp-lint: ## Run ESLint on the Ground Control MCP server (repo-native lint gate)
	npm --prefix mcp/ground-control run lint

# --- Comprehension index (opt-in) ---

graphify: ## (Re)build the disposable Graphify code+docs index (opt-in; see docs/GRAPHIFY.md)
	@command -v graphify >/dev/null 2>&1 || { echo "graphify not installed — run 'uv tool install graphifyy' (docs/GRAPHIFY.md)"; exit 0; }
	graphify extract . --code-only --update

# --- Prose lint ---

vale-install: ## Install Vale prose linter (tools/install-vale.sh → .tools/vale/)
	bash tools/install-vale.sh

# BASE_REF defaults to origin/dev for local invocation. CI sets it to
# origin/<base-branch> for the current pull_request event.
vale-lint: vale-install ## Run Vale on .md docs changed vs BASE_REF, incl. uncommitted (default origin/dev)
	@BASE_REF="$${BASE_REF:-origin/dev}"; \
	CHANGED_DOCS=$$(bash tools/changed-docs.sh "$$BASE_REF"); \
	if [ -z "$$CHANGED_DOCS" ]; then \
	  echo "vale-lint: no changed docs vs $$BASE_REF"; \
	  exit 0; \
	fi; \
	if [ ! -x .tools/vale/current/vale ]; then \
	  echo "vale-lint: Vale not installed at .tools/vale/current/vale; run 'make vale-install'" >&2; \
	  exit 1; \
	fi; \
	.tools/vale/current/vale --config=.vale.ini $$CHANGED_DOCS

# --- Repo policy ---

policy-tests: ## Run unit tests for repo policy tooling
	python3 -m unittest discover -s tools/tests -p 'test_*.py'

policy: policy-tests mcp-lint vale-lint ## Run repo-native policy checks shared by Claude and Codex
	@BASE_REF="$${BASE_REF:-origin/dev}"; \
	python3 bin/policy --base "$$BASE_REF" --skip-pr-body

# --- Repo workflow helpers ---

hooks: ## Activate + verify commit-time pre-commit hooks for this clone (ADR-079)
	bash scripts/install-hooks.sh

devmain: ## Open the dev -> main promotion PR titled so the PR-title gate passes
	@gh pr create --base main --head dev \
	  --title "chore(main): promote dev" \
	  --body "Promotes \`dev\` to \`main\`. Merge with a merge commit — squashing collapses the Conventional Commit subjects Release Please needs and loses this release's CHANGELOG."

ci-timings: ## Measure CI wall clock and time-to-first-failure from recent runs (ADR-091)
	python3 tools/ci/measure_ci_timings.py

branch-protection-check: ## Compare live main/dev protection with the versioned baseline (GC-P031)
	python3 -m tools.ci.check_branch_protection

docs: ## Build the public docs (Read the Docs) with warnings as errors into docs/public/_build
	python3 -m venv docs/public/_build/venv
	docs/public/_build/venv/bin/pip install -q -r docs/public/requirements.txt
	docs/public/_build/venv/bin/sphinx-build -W --keep-going -b html docs/public docs/public/_build/html

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
