# Content basis

Reviewed 2026-09-23. Page language remains English, consistent with the original landing page.

| Page claim | Repository evidence |
| --- | --- |
| Background coding across connected tools | `README.md`, `packages/edge-worker/src/EdgeWorker.ts` |
| Claude Code, Codex, Cursor, Gemini, OpenCode runners | `packages/*-runner`, `README.md` |
| Separate worktrees and repository routing | `packages/edge-worker/src/GitService.ts`, `packages/edge-worker/src/RepositoryRouter.ts` |
| Continuing task conversations | `README.md`, agent session handling in `packages/edge-worker` |
| Self-hosting, BYOK, guided setup | `README.md`, `docs/SELF_HOSTING.md`, `docs/FORK_INSTALLATION.md` |
| Local task board, history, model details and logs | `docs/STATUS_BOARD.md` |
| Scheduled automations on the local board | `docs/AUTOMATIONS.md`, `packages/edge-worker/board/automations.jsx` |
| Open-source license | `LICENSE` (Apache 2.0) |
| Configurable agent and repository settings | `docs/CONFIG_FILE.md` |

Editorial reference: https://www.atcyrus.com/ — reviewed for its task delegation → isolated workspace → coding result narrative and BYOK positioning. Page copy is newly written for this fork. Cyrus customer testimonials, metrics, certification claims, paid plans, cloud service promises, and SRE claims are not transferred to Miko.

The eight conversations illustrate tasks users can delegate. Their issue numbers, filenames, outcomes, and check results are sample content, explicitly labeled as examples. They are not measured Miko results. Research examples return an answer instead of claiming a PR. Provider capabilities, credentials, permissions, and integration setup determine actual behavior.

The board screenshots are the current Board interface, captured from an isolated server with fictional tasks and schedules in `demo/board-snapshot.json` and `demo/automations.json`. They are not a customer workspace.

The installation command is the repository's documented skills bootstrap. The page explains that invoking `/miko-setup`, rather than installing skills alone, installs the runtime. Self-hosting is not described as offline model inference.

## Product naming

The public product name is Miko, with Miko as the full name. @Miko describes the action of mentioning the agent. Existing `mikoagents/miko` repository links, package names, and `/miko-setup` commands remain unchanged because they are executable identifiers. Use the configured bot handle in actual integrations.
