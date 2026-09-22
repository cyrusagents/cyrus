# Test Drive #004: Validation Loop with Planted Bug

**Date**: 2025-12-17
**Goal**: Validate the validation loop implementation by forcing a controlled failure scenario
**Scope**: Large - Testing full validation loop cycle (fail → fixer → retry → pass)
**PR**: upstream PR #666

---

## Test Strategy: Planted Bug Technique

### The Challenge

When testing the validation loop, the agent is "too good" - it typically writes correct code on the first try, so the validation always passes on iteration 1. We needed a reliable way to trigger the failure → fixer → retry path.

### The Solution: Planted Bug Technique

Create a test repository with a **pre-existing bug** that:
1. **Won't be noticed** during the coding phase (agent focuses on new feature)
2. **Will be caught** during the verification phase (tests fail)
3. **Can be fixed** by the fixer subroutine (straightforward bug)

Additionally, the issue instructions explicitly tell the agent **NOT to run tests during coding**, ensuring the bug survives until verification.

---

## Test Repository Setup

### Repository Structure

```
/tmp/validation-fail-test/
├── src/
│   └── string-utils.ts    # Contains planted bug
├── test/
│   └── string-utils.test.ts
├── package.json
├── tsconfig.json
└── .gitignore
```

### The Planted Bug

**File**: `src/string-utils.ts`
**Location**: Line 19, `reverse()` method

```typescript
// PLANTED BUG: Drops the last character!
reverse(str: string): string {
  return str.slice(0, -1).split('').reverse().join('');
}
```

The bug is subtle - `str.slice(0, -1)` removes the last character before reversing, causing all reverse operations to be incorrect.

### Why This Bug Works

1. **Not obvious at a glance** - The code looks plausible
2. **Existing tests will catch it** - The test suite has 3 tests specifically for `reverse()`
3. **Easy to fix** - Just remove the `.slice(0, -1)` call
4. **Unrelated to the new feature** - Agent is asked to add `truncate()`, not fix `reverse()`

### Issue Instructions

The issue was crafted to ensure the bug survives until verification:

```markdown
# Add truncate method to StringUtils

Add a `truncate(str: string, maxLength: number)` method that truncates
strings longer than maxLength and adds "..." at the end.

**IMPORTANT**: Do NOT run the test suite during implementation.
Focus only on writing the truncate method and its tests.
The verification step will handle running all tests.
```

---

## Session Log

### Phase 1: Server Startup (21:11:26)

**Command**:
```bash
ATMIKO_PORT=3602 ATMIKO_REPO_PATH=/tmp/validation-fail-test pnpm run server
```

**Output**:
```
🏎️  F1 Testing Framework Server
Server:     http://localhost:3602
Repository: /tmp/validation-fail-test
```

### Phase 2: Issue Creation (21:13:21)

**Command**:
```bash
./f1 create-issue \
  --title "Add truncate method to StringUtils" \
  --description "..." \
  --labels opus
```

**Output**:
```
✓ Issue created successfully
  ID: issue-1
  Identifier: DEF-1
```

### Phase 3: Session Start (21:13:22)

**Command**:
```bash
./f1 start-session --issue-id issue-1
```

**Key Server Logs**:
```
[EdgeWorker] AI routing decision for session-1:
  Classification: code
  Procedure: full-development
```

### Phase 4: Coding Activity (21:13:31 - 21:14:24)

**Subroutine**: `coding-activity`
**Duration**: ~53 seconds
**Messages**: 24

The agent:
- Read the existing `StringUtils` class
- Implemented the `truncate()` method
- Added tests for `truncate()`
- **Did NOT run the test suite** (as instructed)

### Phase 5: Verification - Iteration 1 (21:14:24 - 21:15:06)

**Subroutine**: `verifications`
**Duration**: ~42 seconds
**Messages**: 21

**Server Log**:
```
[AgentSessionManager] Validation result for iteration 1/4: pass=false,
  reason="3 tests failing in reverse method (pre-existing bug in
  src/string-utils.ts:19 - drops last character..."
[AgentSessionManager] Validation failed, running fixer (iteration 1/4)
```

**Result**: ❌ FAIL
- 3 tests failing in `reverse()` method
- Bug correctly identified as "pre-existing"
- Fixer subroutine triggered

### Phase 6: Validation Fixer (21:15:06 - 21:15:28)

**Subroutine**: `validation-fixer`
**Duration**: ~22 seconds
**Messages**: 9

**Server Log**:
```
[EdgeWorker] Validation loop iteration 1/4, running fixer
[AgentSessionManager] Validation fixer completed for iteration 1,
  re-running verifications
```

The fixer:
- Identified the bug in `reverse()` method
- Changed `str.slice(0, -1).split('').reverse().join('')` to `str.split('').reverse().join('')`
- Saved the file

### Phase 7: Verification - Iteration 2 (21:15:28 - 21:15:55)

**Subroutine**: `verifications` (retry)
**Duration**: ~27 seconds
**Messages**: 11

**Server Log**:
```
[AgentSessionManager] Validation result for iteration 2/4: pass=true,
  reason="17 tests passing, TypeScript type checking passes.
  Implementation includes truncate method and all e..."
[AgentSessionManager] Validation passed after 2 iteration(s)
[AgentSessionManager] Subroutine completed, advancing to next: git-gh
```

**Result**: ✅ PASS
- All 17 tests passing
- TypeScript type checking passes
- Implementation complete

### Phase 8: Git & Summary (21:15:55 - 21:17:00)

**Subroutines**: `git-gh`, `concise-summary`

Final workflow completed successfully:
- Changes committed
- Summary generated
- Session ended

---

## Validation Loop Summary

| Iteration | Result | Reason | Action |
|-----------|--------|--------|--------|
| 1/4 | ❌ FAIL | 3 tests failing in `reverse()` method | Run fixer |
| 2/4 | ✅ PASS | 17 tests passing, TypeScript OK | Advance to git-gh |

**Total Iterations**: 2 of 4 maximum
**Loop Behavior**: Correctly detected failure, ran fixer, re-verified, passed

---

## Fixed Code

**Before (Planted Bug)**:
```typescript
reverse(str: string): string {
  return str.slice(0, -1).split('').reverse().join('');
}
```

**After (Fixed by Fixer)**:
```typescript
reverse(str: string): string {
  return str.split('').reverse().join('');
}
```

---

## Key Findings

### What Worked Well

1. **Planted bug technique** - Effective way to force validation failure
2. **"Don't run tests" instruction** - Successfully kept bug hidden until verification
3. **Structured output parsing** - Correctly extracted pass/fail and reason from Claude
4. **Fixer subroutine** - Identified and fixed the bug autonomously
5. **Re-verification** - Correctly re-ran tests after fix
6. **State management** - `validationLoop` state tracked iterations correctly

### Validation Loop Implementation Details

**Events emitted**:
- `validationLoopIteration` - Fired when validation completes (pass or fail)
- `validationLoopRerun` - Fired when re-running verifications after fix

**Key Files**:
- `packages/edge-worker/src/validation/ValidationLoopController.ts`
- `packages/edge-worker/src/validation/ValidationResultParser.ts`
- `packages/edge-worker/prompts/subroutines/verifications.md`

### Technique Reusability

The **planted bug technique** can be reused for future validation loop testing:

1. Create a repo with working code + one subtle bug
2. Write tests that catch the bug
3. Create an issue for a different feature
4. Add "don't run tests during coding" to instructions
5. Observe validation loop behavior

---

## Metrics

| Metric | Value |
|--------|-------|
| Total Session Duration | ~4 minutes |
| Coding Activity | 53 seconds |
| Verification (iter 1) | 42 seconds |
| Fixer | 22 seconds |
| Verification (iter 2) | 27 seconds |
| Total Messages | ~100 |
| Model Used | claude-opus-4-5-20251101 |

---

## Conclusion

The validation loop implementation is **fully validated** and working as designed. The planted bug technique successfully demonstrated:

1. Detection of test failures during verification
2. Automatic triggering of the fixer subroutine
3. Correct re-running of verifications after fixes
4. Proper advancement to next subroutine on success
5. Accurate iteration tracking and state management

**Recommendation**: This technique should be used for regression testing of the validation loop in future releases.

---

**Test Drive Complete**: 2025-12-17T21:17:00Z
**Commit**: 9f662b8 (feat(edge-worker): Add validation loop with retry logic for verifications subroutine)
