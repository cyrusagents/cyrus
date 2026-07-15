# Surface cross-repo reads as worktree symlinks

When a single-repo session's routed repository sets `readParentDirectory`, Cyrus
already grants read access to sibling checkouts under the shared parent, but the
agent — which only sees its own worktree — cannot discover those paths and falls
back to guessing sibling contracts (DEV-167). Cyrus will make that grant
discoverable by dropping read-only reference symlinks to the sibling repos into
`<worktree>/cross-repo/<name>`, added to the worktree's git exclude so they never
pollute `git status`. This was chosen over injecting the sibling paths into the
system prompt (keeps prompt context lean and lets the agent find the repos the
same way it finds any file) and over registering them as `--add-dir` roots (that
mechanism is reserved for the multi-repo workspace layout, where each repo is a
real sub-worktree). The link target is the canonical checkout, best-effort
fast-forwarded to its latest `origin/<baseBranch>` first — but only when it is
already on its default branch with a clean tree, so a stale reference becomes
current without disturbing any other checkout state, and without spinning up an
extra worktree per sibling (which the deletion path does not discover under the
single-repo layout, and which the base-branch-only fetch optimization exists to
avoid). Writes stay confined to the worktree exactly as `readParentDirectory`
already guarantees, so the symlinks add read discoverability without widening
write access.
