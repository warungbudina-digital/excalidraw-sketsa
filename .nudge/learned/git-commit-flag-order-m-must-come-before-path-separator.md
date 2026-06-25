# `git commit -- <paths> -m "msg"` fails: -m must come BEFORE --

## What went wrong
When committing with explicit paths to avoid hook-staged files (pattern from
`a-hook-pre-stages-files...`), used: `git commit -- path1 path2 -m "msg"`.
Git treats `-m "msg"` as a pathspec (after `--` everything is a path),
producing: `error: pathspec '-m' did not match any file(s) known to git`.

## Fix
Flags (`-m`, `--author`, etc.) must appear BEFORE the `--` path separator:

```sh
# WRONG — -m is after -- and gets treated as a pathspec:
git commit -- deploy/agy/Dockerfile src/Editor.tsx -m "feat: ..."

# CORRECT — -m before --, paths after:
git commit -m "$(cat <<'HEREDOC'
feat: message here

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
HEREDOC
)" -- deploy/agy/Dockerfile src/Editor.tsx
```

## Verification
```sh
git status    # confirm only intended paths appear in "Changes to be committed"
git log --oneline -1   # confirm commit message and author are correct
```
