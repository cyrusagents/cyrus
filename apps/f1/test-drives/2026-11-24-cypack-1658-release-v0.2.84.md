# GitHub review App metadata fallback

**Date** November 24, 2026  
**Runtime code tested** `a3807919bc710d3b710263a8c262cf2633f84e29`  
**Previous release** `v0.2.83`

The only runtime change since v0.2.83 is #1621: when the authenticated GitHub App metadata lookup returns 403 (for example an owner's IP allowlist), review App identity is verified with the same public metadata fetched anonymously. All other changes are version and changelog metadata.

The existing CYPACK-1636 review webhook driver was run against the built EdgeWorker from the release branch, with a temporary copy that returns 403 for the authenticated App lookup and 200 for the anonymous one. The real F1 `/github-webhook` route started exactly one recording runner session with both inline findings and acknowledged once. Duplicate, suggestions-off, trigger-off, cross-org and empty reviews started no session. The driver logged both the authenticated and the anonymous App lookup for each review, confirming the fallback path. All six scenarios passed.

Limitations: synthetic GitHub provider and recording runner, a temporary Cyrus home, no live delivery or model execution.
