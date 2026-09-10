---
name: plan-to-pr
description: Review an implementation of a plan I authored (written by a weaker model on a feature branch) and get it merged. Covers review-against-plan, fixing on the same branch, opening a PR with gh, and merging via the repo's normal gate. Use when a branch exists with plan implementation and the user wants it reviewed and merged.
---

# Plan-to-PR Workflow

Review a weaker model's implementation of a plan I authored, fix it on the same
branch, then open a PR and merge it through the repo's normal gate. This is the
default path whenever a feature branch carries an implementation of one of my
plans and the user asks for review + merge.

## Core principle

- Work is isolated on a feature branch; the base branch (`master`) stays clean.
- The review surface is the diff between base and branch, **not** the branch alone.
- Review against **two references**: (1) the plan — did it implement what was specified? (2) the base diff — correctness, quality, regressions.
- The **strong model** (me) does the review AND the fixes on the same branch. Do not loop the weaker model back — it wastes turns and reintroduces errors.
- Merge through the repo's normal gate: PR if the repo uses PRs, otherwise local diff review + merge.

## Workflow

### 1. Establish the facts

```bash
git remote -v                 # confirm remote + base branch
git log --oneline <base>..HEAD # what the branch added
git diff --stat <base>...HEAD  # three-dot: changes since the common ancestor
```

Confirm `base` (usually `master`). Use **three dots** (`base...branch`) so the
diff shows changes since the shared ancestor, not just the base tip.

### 2. Review against the plan + base diff

- Read the referenced plan (e.g. `@plans/<name>.md`) and check each item was implemented as specified.
- Read the full `git diff base...branch` line by line: type errors, regressions, leftover debug code, behavior that diverges from the plan.
- Flag anything the weaker model added beyond the plan scope ("scope creep") — a frequent failure mode.
- Report findings as: plan-conformance issues first, then code-quality/correctness issues.

### 3. Fix on the same branch (strong model)

Apply fixes directly on the branch so review and repair stay in one place:

```bash
# edit, then
git add -A
git commit -m "fix(<scope>): <what the strong model corrected>"
```

If the branch is not yet on the remote, see step 4. Re-review only the changes
you made; the rest was already reviewed.

### 4. Push + open the PR

```bash
git push -u origin <branch>

gh pr create --base master --head <branch> \
  --title "<conventional-commit style title>" \
  --body "Closes plan \`@plans/<name>.md\`.

<short summary of what changed and why>

Reviewed against the plan + \`git diff master...<branch>\` by Tiel-Coder."
```

Use `gh` (GitHub CLI) — it is installed and authenticated. If `gh` is not
available or the repo does not use GitHub, create the PR via the web UI or skip
straight to a local merge (see step 5).

### 5. Merge via the repo's normal gate

- Repo uses PRs → approve after my confirmation the diff is clean, then **squash merge** to keep history tidy.
- Repo is purely local → no PR needed; local diff review + `git merge` suffices.
- Never merge on my word alone if CI is wired in — confirm CI passed on the PR.

## Review checklist

- [ ] Every plan item implemented as specified.
- [ ] No behavior that diverges from or silently extends the plan.
- [ ] No leftover debug/logging/temp files.
- [ ] Types build (`tsc` / CI green).
- [ ] No regressions in existing behavior.
- [ ] Commit messages follow the repo convention.

## Repo conventions (this repo)

- Base branch: `master`; remote: `origin` → `bshener/pi-subagents`.
- Branch naming: `plan-<name>` (e.g. `plan-split-index`).
- Merge: squash merge after review + CI.
- Commits: conventional-commit style (e.g. `feat:`, `fix(scope):`, `chore:`).
- Plan references appear in commit messages and PR bodies as `@plans/<name>.md`.

## Anti-patterns

- Do not ask the weaker model to iterate on review comments — fix it yourself on the branch.
- Do not review the branch as a black box — always diff against the base.
- Do not merge on the base branch; keep the base clean.
- Do not skip plan-conformance because the code "looks fine" — a plausible-looking
  implementation can still violate the plan.
