# GitHub Actions maintenance and main protection

## Workflow dependencies

Both workflows pin every external action to its full upstream commit. The
version comments identify the releases resolved from the existing major tags on
2026-10-04; this change preserves their versions, runtimes and inputs. GitHub's
[secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use)
requires checking that a SHA belongs to the upstream repository, not a fork.

| Upstream action | Resolved tag | Commit |
| --- | --- | --- |
| `actions/checkout` | v5.1.0 (CI's v5) | [`fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`](https://github.com/actions/checkout/commit/fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09) |
| `actions/checkout` | v4.4.0 (publisher's v4) | [`11d5960a326750d5838078e36cf38b85af677262`](https://github.com/actions/checkout/commit/11d5960a326750d5838078e36cf38b85af677262) |
| `actions/setup-python` | v6.3.0 (CI's v6) | [`ece7cb06caefa5fff74198d8649806c4678c61a1`](https://github.com/actions/setup-python/commit/ece7cb06caefa5fff74198d8649806c4678c61a1) |
| `actions/setup-python` | v5.6.0 (publisher's v5) | [`a26af69be951a213d495a4c3e4e4022e16d87065`](https://github.com/actions/setup-python/commit/a26af69be951a213d495a4c3e4e4022e16d87065) |
| `actions/setup-node` | v5.0.0 | [`a0853c24544627f65ddf259abe73b1d18a591444`](https://github.com/actions/setup-node/commit/a0853c24544627f65ddf259abe73b1d18a591444) |
| `actions/upload-artifact` | v4.6.2 | [`ea165f8d65b6e75b540449e92b4886f43607fa02`](https://github.com/actions/upload-artifact/commit/ea165f8d65b6e75b540449e92b4886f43607fa02) |
| `astral-sh/setup-uv` | v7.6.0 (CI's v7) | [`37802adc94f370d6bfd71619e3f0bf239e1f3b78`](https://github.com/astral-sh/setup-uv/commit/37802adc94f370d6bfd71619e3f0bf239e1f3b78) |
| `astral-sh/setup-uv` | v6.8.0 (publisher's v6) | [`d0cc045d04ccac9d8b7881df0226f9e82c39688e`](https://github.com/astral-sh/setup-uv/commit/d0cc045d04ccac9d8b7881df0226f9e82c39688e) |

The initial inventory contains 13 external uses in two workflows and no
reusable-workflow calls, local/composite actions or container action references.
Canonical GitHub repository metadata (`full_name`, `fork=false`), peeled major
and release-tag refs, the commit endpoint's SHA/signature verification and
`action.yml` at each SHA were checked. All eight upstream commit signatures were
valid. They also matched the action-download SHAs in the latest successful
CI and publisher logs at the baseline revision, confirming version preservation.
A signature is provenance evidence, not a complete source security audit.

Every checkout opts out of Git credential persistence, following the upstream
[checkout documentation](https://github.com/actions/checkout/blob/fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09/README.md).
No current step pushes, fetches private repositories or otherwise needs retained
Git authentication. Both workflows retain `contents: read`. CI still runs on
`push` and `pull_request`; it references no repository secrets. The publisher
still runs only on its existing schedule or owner dispatch. Its cycle input is
passed through an environment variable, rather than interpolated into shell code.
R2 credentials remain scoped to the upload step; CMEMS credentials serve the
optional current step (the username-presence flag remains at job scope).

The publisher retains `group: prepare-synoptic`, `cancel-in-progress: false`, its
45-minute timeout, optional-current failure handling and the paid-work/capacity
gates. Cancellation or a new concurrency policy must not interrupt pointer-last
publication. CI has no concurrency stanza; this change adds none. Pins do not
freeze runner images, package registries or upstream weather data. Credential
rotation, provider admission and scientific acceptance have separate gates.

## Verification and deliberate updates

Run `bash scripts/check-workflows.sh` from the repository root. The same command
runs in CI's existing `shared-contracts` job. It downloads the official
[actionlint 1.7.12 release](https://github.com/rhysd/actionlint/releases/tag/v1.7.12)
for the supported Linux x86_64 environment, verifies its committed SHA-256 before
extracting/executing, checks every `.yml`/`.yaml` workflow and removes scratch
files. The archive digest was matched to both the release API asset digest and
upstream checksum file. Its built-in checks cover YAML structure, Actions
expressions, inputs and contexts. Shellcheck and pyflakes integrations are
explicitly disabled to avoid varying with optional local installations; the
existing JS/TS and Python gates remain required. Download/checksum errors fail
closed; no unverified fallback is executed.

The maintainer owns action updates: review at the next routine maintenance and
at least monthly, and promptly when an upstream security advisory applies. No
new scheduler, bot, automatic merge or PR requirement is configured.

1. Inventory **all** workflow `uses:` again, including future reusable workflows,
   local action dependencies and container digests. Review upstream release notes,
   advisories, action inputs and runner/runtime compatibility before choosing an
   exact release. Do not silently change a major version or follow `latest`.
2. Resolve the tag through the **canonical** upstream GitHub API. For example:

   ```bash
   gh api repos/actions/checkout --jq '{full_name,fork,html_url}'
   gh api repos/actions/checkout/git/ref/tags/v5.1.0 --jq '{ref,object}'
   ```

   If `object.type` is `tag`, fetch `git/tags/<object.sha>` and follow its
   `object` until the type is `commit`. Compare any major alias with this exact
   release; a changed/mismatched tag requires investigation. Verify the resulting
   full SHA at `repos/<owner>/<repo>/commits/<sha>` and inspect only the public
   `sha`, `html_url` and `commit.verification` fields. Review signature exceptions
   explicitly; never substitute a fork commit. Inspect `action.yml` and source at
   that SHA. Update every intended occurrence and its version comment together.
3. To update actionlint, review its release notes, download the versioned archive
   and checksum file from `rhysd/actionlint`, compare with the GitHub release API
   asset digest, then change the version **and** committed archive SHA-256 in
   `scripts/check-workflows.sh`. Verify before executing the binary.
4. Run workflow lint and the substantive [repository gates](testing.md). Keep
   Node 24/Python 3.12, frozen fixtures and scientific thresholds intact. Deliver
   explicit paths with a normal commit/push to `main`. Read back remote SHA and
   exact-SHA hosted jobs; blocked, skipped or missing proof remains unresolved.
   Inspect naturally scheduled publisher evidence separately; never dispatch
   paid production just to test a pin. A paused successful job is not publication
   proof. Pages' existing main deployment remains the authorized flow.
5. For rollback, revert only the offending scoped change with a new normal
   commit, preferably selecting the prior verified SHA. Reverting the whole
   pinning change restores mutable tags and credential persistence; use that
   broader rollback only after reviewing its security impact. Never reset or
   force-push `main`.

## Main protection proposal (approval required)

[`.github/main-protection.json`](../.github/main-protection.json) is an exact
**proposal**, not an activated provider configuration. It defines the repository
ruleset `main-history-safety`, active only for `refs/heads/main`, with `deletion`
and `non_fast_forward` rules and **no bypass actors**. Normal fast-forward pushes
remain available to authorized writers, including the owner and the existing
main deployment flow. No update restriction, mandatory PR/review, signed-commit,
linear-history, status-check, deployment or merge-queue rule is included.

GitHub documents these [branch rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
and the [ruleset REST API](https://docs.github.com/en/rest/repos/rules).
All push actors, including administrators, are subject to these two rules;
administrators retain the ability to deliberately edit/disable the ruleset.
Avoid a blanket admin/owner bypass, which would also exempt accidental
force-pushes. Blocking force-push can prevent renaming/changing the default
branch; plan such maintenance separately. This protection cannot prevent a
harmful normal commit or an administrator changing the rules.

Required checks are omitted because CI evaluates the newly pushed SHA **after**
a direct push. Requiring those results before its first push can prevent that
flow or require a broad bypass. Even green post-push CI alone does not establish
compatible bootstrap ordering. Revisit checks only under a separately demonstrated
contribution/deployment design and approval.

Before activation, refresh `branches/main`, legacy `branches/main/protection`,
`rulesets?includes_parents=true` and `rules/branches/main`; compare them with the
approved proposal and check for overlapping organization rules. Confirm the
owner still has administration access. Preserve existing rules; do not blindly
create a duplicate or replace an equivalent implementation. Keep the fresh
snapshot, returned ruleset ID and approval in private audit evidence.

After explicit approval, when no equivalent/conflicting rule exists:

```bash
gh api --method POST repos/deepregatta/passage/rulesets \
  --input .github/main-protection.json \
  --jq '{id,name,target,enforcement,bypass_actors,conditions,rules}'
```

Read back `repos/deepregatta/passage/rulesets/<returned-id>` with the same field
whitelist and `repos/deepregatta/passage/rules/branches/main` (types and ruleset
IDs). Require the exact main condition, active enforcement, empty bypass list
and both rule types. Confirm remote `main` SHA and existing workflow states;
observe the next authorized ordinary push/CI/deployment. Do not attempt actual
branch deletion or force-push as a production probe. Successful activation and
API read-back do not by themselves prove a later push/deployment.

Rollback, within the approved activation/recovery scope: disable **only this
returned ID** (never another actor's ruleset), then read back disabled enforcement
and the effective main rules. With no pre-existing rules, disabling restores the
original unprotected policy without deleting a branch or any data:

```bash
gh api --method PUT repos/deepregatta/passage/rulesets/<returned-id> \
  -f enforcement=disabled \
  --jq '{id,name,enforcement}'
```

No paid plan, visibility, subscription, credential or access-role change is
needed by this proposal. Activation is held until owner approval; the current
live state and final delivery results belong in the private dated P03 report.
