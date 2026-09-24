# Scheduled repository tasks

Open the local [status board](./STATUS_BOARD.md) and choose **Automations → New automation**.
Choose a configured repository, describe the work, and select **Run directly** or **Create Linear issue**.
Direct execution creates an isolated worktree and uses the repository's runner, model, permissions,
and development instructions. Linear execution also requires a connected agent workspace and a team;
a project is optional. The issue is created and delegated to the connected Miko agent, then follows
the normal webhook execution flow. The repository must belong to that workspace.

Choose once, daily, weekly, or a five-field cron expression (minute, hour, day, month, weekday).
Daily, weekly and cron schedules use the saved IANA timezone; the initial value comes from your browser.
Single appointments use the browser's local date/time and save an absolute instant. The form automatically previews
up to five future executions using the same calculation as the scheduler. Daylight-saving transitions
follow cron-parser's timezone rules. Cron has a minimum granularity of one minute.

Miko must remain running. Startup and long suspensions skip missed occurrences and advance to the
next future time; there is no catch-up burst. Normal triggers allow up to 60 seconds of delay.
A missed one-time appointment is marked **missed** and can still be run manually.

## Managing schedules

- **Edit** changes future runs; existing runs retain their task definition snapshot.
- **Pause / Resume** affects future triggers. Resuming starts with the next future occurrence.
- **Run now** leaves the scheduled time unchanged. Repeated requests with the same request ID return the same run.
- **Archive** stops future triggers and retains history. The **Archived** tab reveals old schedules.
- Each schedule permits one unfinished run. New occurrences during dispatch, execution, input waits or
  uncertain recovery are recorded as **skipped**. Different schedules may execute concurrently.

Runs link to their Linear issue, local session activity and any reported PRs. **succeeded** means the
agent supplied a final development outcome: verified work with a PR, or a reason that no change was needed.
It does not wait for PR merge. An intermediate reply or missing final outcome is not success.

## Recovery

**waiting_session** means an issue was dispatched but execution has not yet been confirmed.
After five minutes without confirmation, check delegation, webhook delivery and repository access.
**awaiting_input** requires an answer in the linked Linear conversation. Direct tasks have no external
conversation; inspect their activity and revise the task instructions for a new run if clarification is needed.

**Check execution** queries current local/Linear state. Uncertain runs retain their overlap reservation.
Only use **Confirm execution ended** after verifying the old agent has stopped. The server rechecks
execution before releasing the reservation and records the cleared run as failed. It does not cancel a live agent.
Agent failures are not automatically rerun; use **Run now** after addressing the cause.

Temporary dispatch failures have up to three attempts. Linear attempts reuse one persisted issue UUID.
Direct execution is never relaunched after an ambiguous start. After a worker restart, unresolved work
is reconciled or marked uncertain rather than blindly dispatched again.

Schedules and runs are stored in `<mikoHome>/automations/state.json` (schema version 1). One worker owns
this directory through a process lock. Writes are serialized and atomically replaced before dispatch.
A storage failure stops new dispatches and appears on the page; repair storage and restart the worker.
Back up this directory with your Miko data. Do not remove its lock while a worker is running.
Credentials remain in the existing connections and are not included in schedule definitions or browser options.

## Local API

All endpoints are under `/board/api/automations` and share the board's loopback-only access controls.
POST, PATCH and DELETE require an `Origin` matching the local HTTP server and `Content-Type: application/json`.

| Method / path | Operation |
| --- | --- |
| `GET /`, `POST /` | List or create definitions |
| `GET /:id`, `PATCH /:id`, `DELETE /:id` | Read, edit/pause, or archive |
| `POST /preview` | Preview `{schedule, timezone}` |
| `POST /:id/run` | Run with `{requestId}` |
| `GET /:id/runs` | Read history |
| `POST /:id/runs/:runId/reconcile` | Query execution state |
| `POST /:id/runs/:runId/confirm-ended` | Confirm stopped execution with `{confirmedEnded: true}` |

Edits and archiving require the current `revision`; stale revisions return HTTP 409.
An edit sends `{revision, input}`; pause/resume sends `{revision, enabled}`.
The options endpoints expose configured repository/workspace names and Linear teams/projects.

The interface uses locally bundled [Fluid Functionalism](https://www.fluidfunctionalism.com/docs) components,
including animated controls, accessible dialogs and selects, and a searchable schedule list.
