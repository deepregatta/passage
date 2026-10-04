#!/usr/bin/env bash
# actionlint upstream release; see docs/github-actions.md for verification/updates.
set -euo pipefail

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'This verifier requires Linux x86_64 (the supported CI/local environment).' >&2
  exit 1
fi

workflow_lint_dir=$(mktemp -d)
trap 'rm -rf "$workflow_lint_dir"' EXIT
workflow_lint_archive=actionlint_1.7.12_linux_amd64.tar.gz
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 120 --retry 2 \
  "https://github.com/rhysd/actionlint/releases/download/v1.7.12/$workflow_lint_archive" \
  --output "$workflow_lint_dir/$workflow_lint_archive"
(
  cd "$workflow_lint_dir"
  printf '%s  %s\n' \
    '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8' \
    "$workflow_lint_archive" | sha256sum --check --strict
  tar -xzf "$workflow_lint_archive" actionlint
)
shopt -s nullglob
# Explicit glob covers every current workflow, including newly added files.
# Shellcheck/pyflakes are separate tool installations; use deterministic built-in checks.
"$workflow_lint_dir/actionlint" -shellcheck= -pyflakes= .github/workflows/*.yml .github/workflows/*.yaml
