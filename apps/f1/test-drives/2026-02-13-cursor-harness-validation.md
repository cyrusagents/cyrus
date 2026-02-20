# Test Drive: Cursor Harness Validation (Offline)

**Date**: 2026-02-13
**Goal**: Prove Cyrus can run a full session with `cursor` selected as the agent via F1 harness.
**Driver**: `apps/f1/test-drives/cursor-offline-drive.ts`

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Session created on issue

### EdgeWorker
- [x] Session started
- [x] Runner selection resolved to `cursor`
- [x] Session completed and posted final response activity

### Renderer / Activities
- [x] Activities recorded throughout run
- [x] Final `response` activity present

## Command

```bash
bun run apps/f1/test-drives/cursor-offline-drive.ts
```

## Key Evidence

- Log line confirms runner selection:
  - `[EdgeWorker] Label-based runner selection for new session: cursor (session session-1)`
- Final result payload:

```json
{
  "ok": true,
  "issueId": "issue-1",
  "identifier": "DEF-1",
  "sessionId": "session-1",
  "activityCount": 29,
  "responseCount": 1
}
```

## Conclusion

Pass. The F1 test harness demonstrates successful end-to-end session execution with `cursor` agent selection and a posted final response activity.
