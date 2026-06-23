# A hook pre-stages files; `git add <paths>` + `git commit` sweeps them in too

## What went wrong
The repo's PreToolUse hook (`nudge claude hook` in `.claude/settings.json`) stages its own
config between commands — `.nudge/rules.yaml` and a `$HOME` portability fix to
`.claude/settings.json`. `git commit` commits the ENTIRE index, not just the paths passed to
a preceding `git add`. So commits intended to be scoped (explicit `git add a b c; git commit`)
silently also included `.claude/settings.json` + `.nudge/rules.yaml` (e.g. commit fa92769 had
9 files when only 7 were add-ed). These two had been deliberately left out across the session.

## Fix
Commit with an explicit pathspec so ONLY those paths are committed regardless of what else the
hook staged: `git commit -- <path1> <path2> ...` (or `git commit <paths>`). FLAG ORDER MATTERS:
`-m "msg"` must come BEFORE `--`, because `--` ends option parsing and everything after it is a
pathspec. So write `git commit -m "msg" -- <paths>` — NOT `git commit -- <paths> -m "msg"`
(the latter aborts: `error: pathspec '-m' did not match any file(s)`, HEAD untouched, no harm
done — just rerun with the right order). Before committing,
inspect the index with `git diff --cached --name-only` (or `git status --short`) and `git
restore --staged <unwanted>` to drop hook-staged files. To undo an already-made local commit
that swept extras in (not pushed): `git reset --soft HEAD~1` then re-stage precisely, or
`git restore --staged --worktree=false` selectively. `.claude/settings.json` ($HOME fix) and
`.nudge/rules.yaml` (nudge ruleset) are legitimate to track — the issue is bundling them into
an unrelated feature commit, not their content.

## Verification
After `git add <intended>`, run `git diff --cached --name-only` and confirm it lists ONLY the
intended files before `git commit`. Prefer `git commit -- <paths>` to make the scope explicit.
