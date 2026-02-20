# Test Drive: Cursor Stop + Tool Logging Validation

**Date**: 2026-02-13
**Goal**: Validate CYPACK-804 acceptance criteria in F1 end-to-end flow for cursor sessions.
**Test Repo**: `/tmp/f1-cypack-804-1771021423`
**Server Port**: `3626`

## Acceptance Criteria

1. `stop-session` does not advance to the next subroutine.
2. Cursor tool calls are logged to timeline activities.

## Setup

- Started F1 server with a deterministic cursor-agent stub in `PATH` and writable Claude config:
  - `PATH=/tmp/fake-bin:$PATH`
  - `CLAUDE_CONFIG_DIR=/tmp/f1-claude-config`
- Created issue with:
  - `[agent=cursor]`
  - `[model=gpt-5]`
  - coding-oriented description to force `full-development` procedure.

## Session Log (Key Commands)

```bash
CYRUS_PORT=3626 ./f1 create-issue --title "CYPACK-804 acceptance proof 2" --description "... [agent=cursor] [model=gpt-5]"
CYRUS_PORT=3626 ./f1 start-session --issue-id issue-2
sleep 10
CYRUS_PORT=3626 ./f1 stop-session --session-id session-2
CYRUS_PORT=3626 ./f1 view-session --session-id session-2 --limit 200
```

## Evidence

- Procedure selected as full-development before stop:
  - `Selected procedure: **full-development** (classified as: code...)`
- Tool call activity rendered to timeline:
  - `action    {"type":"action","action":"Bash (echo f1-tool)",...}`
- Stop result posted:
  - `response  I've stopped working on CYPACK-804 acceptance proof 2...`
- No activity indicating subroutine advancement after stop (no "advancing to next subroutine" activity).

## Result

**PASS**

- Acceptance criterion 1: met (session stopped without subroutine progression activity).
- Acceptance criterion 2: met (tool call logged as `action` activity in timeline).
