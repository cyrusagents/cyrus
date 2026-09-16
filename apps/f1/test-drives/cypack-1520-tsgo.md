# CYPACK-1520: Native TypeScript compiler validation

**Date:** 2026-09-15

## Compile-time comparison

Baseline: `5b3e38bd` (`main`), TypeScript 5.9.3. Migrated compiler: `@typescript/native-preview@7.0.0-dev.20260707.2` (`tsgo`).

Environment: macOS arm64, Node.js 26.5.0, pnpm 10.33.1. Both compilers ran in the same worktree on the same host. Dependencies were installed before timing; no other validation commands ran alongside the benchmarks.

For each compiler, ran `pnpm build` four times, then `pnpm typecheck` four times. The first run of each command was a warm-up, excluded from the median. These are wall-clock timings including pnpm scheduling, compiler startup, and build asset copying. Incremental compilation is not enabled; subsequent builds still perform full checking and emit with existing output directories. These are local measurements, not CI estimates.

| Command | tsc median | tsgo median | Speedup | Time reduction |
| --- | ---: | ---: | ---: | ---: |
| `pnpm build` | 6.758s | 1.730s | 3.91× | 74.4% |
| `pnpm typecheck` | 5.597s | 1.767s | 3.17× | 68.4% |

### Raw wall-clock samples (seconds)

| Compiler / command | Warm-up (excluded) | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: | ---: |
| tsc / build | 7.747728 | 6.193909 | 6.757783 | 6.896652 |
| tsc / typecheck | 5.628186 | 5.583218 | 5.636706 | 5.597097 |
| tsgo / build | 2.056288 | 1.845317 | 1.685977 | 1.730450 |
| tsgo / typecheck | 1.736039 | 1.866371 | 1.767065 | 1.596411 |

### Reproduction

Use separate checkouts of the baseline commit and this change, with the same Node/pnpm versions. Run `pnpm install --frozen-lockfile` in each. Then run this from each checkout (all commands must exit successfully):

```python
import subprocess, time
from statistics import median

for command in ("build", "typecheck"):
    samples = []
    for run in range(4):
        start = time.perf_counter()
        subprocess.run(["pnpm", command], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        samples.append(time.perf_counter() - start)
    print(command, "samples:", samples, "median:", median(samples[1:]))
```

## Migration details

- All 18 TypeScript projects use `tsgo` for build, typecheck, and watch scripts, with an exact dev dependency in each package and the workspace root. Existing asset-copy steps are preserved.
- Removed `baseUrl`; path aliases now resolve relative to their declaring configuration.
- Explicit Node types replace implicit discovery. The shared default uses NodeNext module resolution instead of removed Node10 resolution.
- Explicit source roots preserve the existing package and CLI output layouts under the new compiler.

## Validation

- Clean `tsgo` build succeeds after deleting all workspace `dist` directories. All 909 output file paths match the `tsc` inventory, including JavaScript, declarations, maps, and copied assets. This checks paths, not byte-for-byte output identity.
- Full type checking succeeds.
- `pnpm -r --no-bail test:run`: 1,958 passed, 2 skipped, across 162 test files; F1 has no unit test files.
- `pnpm lint`: passes with 12 existing warnings.
- `pnpm audit`: zero advisories. No security overrides were added or changed.
- Watch-mode runtime validation is blocked in this macOS sandbox: both default watch and explicit polling flags report `error starting FSEvents stream`. Build and typecheck work; watch behavior outside the sandbox remains unverified.

## F1 test drive

Test repository: `/tmp/cypack-1520-f1-repo`, scaffolded with `apps/f1/f1 init-test-repo`. The server and CLI use the JavaScript emitted by `tsgo` (`node apps/f1/dist/server.js` and `apps/f1/f1`).

### Results

- [x] Compiled server starts; `ping` and `status` return successfully.
- [x] Issue creation returns `issue-1` / `DEF-1` and its metadata.
- [x] Session creation returns `session-1`; repository selection resumes routing.
- [x] Git worktree is created and session activities appear with timestamps and readable types/content.
- [x] Pagination (`--limit 2 --offset 2`) returns the requested slice.
- [x] Both sessions stop successfully; both server processes are stopped.
- [ ] Agent completes the README summary.

### Session log and limitations

1. Started the compiled server on port 3600 with the default Claude runner. Created an issue asking for a one-sentence README summary without code changes. Started the session and selected `F1 Test Repository` using `prompt-session`.
2. Routing and session initialization succeeded, but Claude returned `401 OAuth access token has expired`. Stopped the session and server.
3. Repeated on port 3601 with `CYRUS_DEFAULT_RUNNER=codex` after `codex login status` confirmed a ChatGPT login. Routing and activity rendering succeeded, but the runner returned `codex app-server exited (code=1, signal=null)` before doing the task. Stopped the session and server.

**Result:** Compiled runtime startup, issue tracking, worktree/session setup, activity rendering, pagination, and stopping passed. Full F1 agent completion did not pass; the two runner failures above remain validation limitations. Unit tests and compiler checks pass independently.

## CI timeout correction

The initial Node 22 CI run timed out after 30 seconds in `prompt-assembly.multi-repo.test.ts` (the user-comment scenario). The prompt-test helper supplied fake trackers through an obsolete `issueTrackers` configuration property. `EdgeWorker` ignored that property and created real Linear clients, so prompt assembly made live requests with the test token. The mock methods also used outdated `getComments` names rather than the current `fetchComments` interface.

The helper now installs its doubles into the shared tracker map after construction and uses the current fetch methods. A regression guard rejects and counts calls to the live tracker in all seven multi-repo scenarios; all seven failed with the original helper and pass with the correction. Full prompt assertions remain intact.
