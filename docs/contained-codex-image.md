# Local contained Codex image

This is a local test artifact, not a registry release. The reviewed Linux arm64
image/config ID is `sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f`.
It contains Node22 slim base ID
`sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`
and the native binary from `@openai/codex@0.153.3-linux-arm64`, archive SHA256
`c919c02e317d1d333daf6a1f3652ba24b4a415344636a5339255db9a36454b07`.
Only `package/vendor/aarch64-unknown-linux-musl/bin/codex` is added at
`/usr/local/bin/codex`. No credentials, runtime files, mounts or user configuration
are included.

`/tmp/cypack-1546-codex-image/contained-codex-0.153.3-arm64.tar` is the exported
Docker save archive. Its SHA256 is
`9f0ac91cef8437c4aa2a0788eddfb309c377bd361dc1b646020aa4f143f465de`.
The coordinator may verify and load it into its own authorized same-user daemon:

```sh
shasum -a 256 /tmp/cypack-1546-codex-image/contained-codex-0.153.3-arm64.tar
docker --host unix:///Users/connor/.colima/cyrus-verifier-1321/docker.sock image load --input /tmp/cypack-1546-codex-image/contained-codex-0.153.3-arm64.tar
docker --host unix:///Users/connor/.colima/cyrus-verifier-1321/docker.sock image inspect sha256:35ffa8e695666695f047cf527138b9b27f2e1c29d44673f9eb705a0e4010be4f
```

Verify exact Id, Linux/arm64 and no Config.Volumes. No context switching or daemon
ACL changes are required. This archive is architecture-specific, not an OCI
multi-platform index. A different architecture needs its own reviewed base and
native archive; do not reuse these identities.

For a rebuild, first obtain/review the exact upstream platform archive and preload
the base locally, then invoke the checked-in builder:

```sh
node scripts/build-contained-codex-image.mjs /absolute/path/to/docker unix:///own/docker.sock sha256:REVIEWED_BASE /path/to/openai-codex-0.153.3-linux-arm64.tgz c919c02e317d1d333daf6a1f3652ba24b4a415344636a5339255db9a36454b07 arm64
```

The builder checks archive hash/version, base architecture/volumes, then locally
creates/copies/commits one binary with no pull or network installation. A rebuild
has a new image ID because Docker commit metadata includes creation time; record
that new identity and provenance rather than claiming the original ID.

Runtime launch keeps `CYRUS_APP_URL=https://cyrus-preview-cyhost-1321.vercel.app`
for this authorized preview and uses `CYRUS_CONTAINED_CODEX_IMAGE` plus the explicit
`CYRUS_CONTAINED_DOCKER_HOST`. Existing same-user `.codex` login stays in place.
The coordinator owns runtime replacement and live checks. This document grants no
release, production enablement or deployment authority.
