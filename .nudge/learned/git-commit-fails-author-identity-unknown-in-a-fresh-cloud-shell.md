# git commit fails "Author identity unknown" in a fresh Cloud Shell

## What went wrong
This runs in an EPHEMERAL Google Cloud Shell, so `git config user.name/user.email` is NOT
set at the start of a session. The first `git commit` aborts with:
`Author identity unknown ... unable to auto-detect email address (got '...@cs-...ephemeral...(none)')`
even though the repo already has commits — the prior identity didn't persist.

## Fix
Set a repo-local identity matching the existing history before committing:
`git config user.name "dina_aryanti12"` and `git config user.email "warungbudina@gmail.com"`
(the author of the existing commits; confirm with `git log -1 --format='%an <%ae>'`). Use
repo-local config (no `--global`) since the home dir is ephemeral anyway. Note the broader
session rule: commit work to Git before the session ends — the disk is ephemeral and local
work is lost on reset.

## Verification
`git log -1 --format='%an <%ae>'` shows the expected author, and `git commit` succeeds.
