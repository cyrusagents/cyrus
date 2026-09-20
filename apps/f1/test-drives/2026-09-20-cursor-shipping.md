# Cursor workflow and PR completion

Date: 2026-09-20

A normal code-fix request must reach verification, commit, push, and PR creation without a second approval prompt.

## Fixture

- Real Cursor SDK 1.0.31 with Grok 4.6, through the F1 CLI issue tracker and EdgeWorker.
- Node 24, local server on port 3600.
- Temporary greeting repository, a local bare Git remote, and a local `gh` simulator. No real GitHub PR was created for this fixture.
- Request: “The greeting function returns helo. Fix it to return hello and verify with the existing test.” Description selected Cursor/Grok; the `primary` label selected the fixture repository. The request did not explicitly ask for a commit or PR.
- Default Cyrus workflow skills copied into the isolated F1 home.

## Verified

- F1 issue creation and label routing succeeded; an isolated worktree was created/reused.
- Cursor read the supplied task directory, fixed the greeting, and passed the existing test, lint, and typecheck scripts.
- Commit `df82113` reached the local bare remote.
- The simulator recorded `gh pr create --title "Fix greeting typo" --base main` with a full summary, validation, issue link, and Cyrus marker.
- The final response included the simulated PR URL, without asking permission to submit.
- Activity rendering showed thought, action, and response entries; pagination worked.
- EdgeWorker logged session completion with subtype `success`.
- Regression tests additionally cover create/resume instruction delivery, scoped skill staging and cleanup, bounded Stop-hook continuation, post-tool hook ordering, cancellation, and SDK failure.

## Findings

The old adapter discarded `appendSystemPrompt`, excluded Cursor from managed skill configuration, and did not invoke the shared completion hooks. Recent production tasks therefore stopped with uncommitted files and offered to open a PR later.

An initial experiment with only a project rule was insufficient: F1 runs under both Bun and Node exposed the host repository context despite the requested SDK working directory. The final adapter explicitly includes the task directory, Cyrus instructions, and readable skill paths in every request, retaining Cursor's built-in system prompt. The real F1 run above validated that path. Native project discovery is not relied upon to deliver the workflow instructions.

The completion hook uses the existing one-continuation guardrail. It does not promise a PR when authentication, tests, or repository policy prevent shipping; those failures must still be reported by the agent. GitHub server-side PR creation was simulated here.
