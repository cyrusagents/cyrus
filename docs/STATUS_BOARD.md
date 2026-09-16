# Local status board

Start Cyrus normally, then open [http://127.0.0.1:3456/board](http://127.0.0.1:3456/board).
The board starts and stops with the same application server as `/status` and the webhook endpoints.
Use your configured server port if it differs from 3456. No second server, command, or port is needed.

For this fork, follow [Fork Installation](./FORK_INSTALLATION.md) and start it with the verified source launcher. Installing the official npm package or only downloading the setup skills does not install the board changes.

The English interface has a task list and a live log pane. Select a task, search tasks or logs,
filter by source or errors, wrap long lines, pause the display, or follow new entries.
Search supports highlighting, previous/next match navigation, and matching-line filtering.
Scrolling up or typing a search disables Follow; enabling Follow returns to the latest output.
Task titles and log messages retain their original language.

## Data and status

- Running comes directly from each session's live runner. A process-wide busy status never makes an idle task appear running.
- The board includes issue sessions and chat sessions managed by this Cyrus instance.
- Agent logs include assistant text, tool calls, tool results, and completion/error results from the common runner message interface.
- Cyrus logs come from its structured logger, starting when the board is registered. Historical stdout/stderr files are not scanned.
- Saved assistant, tool, tool-result and completion entries are merged with live output, including after a restart or a resumed turn. Matching output is shown once, using its saved timestamp.
- Issue sessions are archived before terminal-state or age-based cleanup, even when no browser is open. Archived tasks remain in the list after restart and are labeled `Archived`; they never appear as running. If a session is resumed, its live record takes precedence.
- The archive is stored in `<cyrusHome>/state/board-history.json` with atomic writes. It keeps up to 200 removed tasks and the latest 100 public agent log entries per task, within 16 MiB overall; the oldest tasks are evicted first. Storage failures show a warning and do not stop Cyrus.
- Snapshots show up to 60 retained sessions, prioritizing running tasks, plus the archive. Live logs retain 650 recent entries. Individual entries are limited to 4,000 characters. Selecting an archived task loads its own logs, so new activity cannot displace them from the shared live log window.
- This archive starts when the updated worker is installed. Tasks already deleted before installation cannot be reconstructed automatically. Chat sessions are shown while retained by their chat handler; the removal archive follows the issue-session manager.
- Agent messages use the session update time for initial history and the time first observed by the board for new messages. These are observation times, not exact SDK event timestamps.

The page receives snapshots over `/board/events` every two seconds while it is open.
`/board/api/snapshot` supplies the same data as JSON. Closing the last page stops the streaming timer.
`/board/api/history/:sessionId` supplies an archived task's bounded log entries on demand.
The existing `/status` response remains unchanged.

## Local access

The board and its data endpoints accept direct loopback connections with a localhost/loopback Host header.
Remote connections, forwarded/proxied requests (including Cloudflare Tunnel), and foreign browser origins are rejected.
Webhook and OAuth endpoints keep their existing behavior. The board is read-only.

Only selected session fields and visible output are sent to the browser. User/system prompts,
reasoning blocks, runner/config objects, and workspace paths are not serialized as session metadata.
Common credential formats are redacted from text. Logs can still contain project content, so the board stays local.

## Development

The UI source is in `packages/edge-worker/board/`. Run `pnpm --filter cyrus-edge-worker build:board`
after editing it. The regular edge-worker build includes this step and packages the generated files under `dist/board/`.
React and React LogViewer are bundled locally; no CDN or extra frontend process is used at runtime.

The pinned React LogViewer 6.5.5 component has a small compatibility adapter for empty filtered results
and match navigation after filtering. Tests cover both cases. The dependency's original files remain unchanged.
Its pinned Immutable dependency is overridden to 5.1.9 to include the upstream security fixes;
remove that scoped override when React LogViewer updates its dependency.

React LogViewer source: https://github.com/melloware/react-logviewer (MPL-2.0).
Its license and bundled dependency notices are included with the generated assets.
