# Local runtime artifact bootstrap for independent CI

This is build/install tooling for CYPACK-1546 / CYHOST-1321. It does not publish
packages or authorize release, deployment, live providers or model calls.
Runtime implementation remains pinned to
`269e051d4a7190c46999ed38773297662dd526f3` (17 packages). Fetch the builder and
verifier from a separately reviewed tooling commit; record that commit as well.

## Build and install

Use two clean checkouts: `runtime` at the tested source and `tooling` at the
reviewed builder commit. Node 24 and pnpm 10.33.1 are suitable CI inputs. Record
actual Node/npm/pnpm versions. Run from a disposable standard CI job, with no
provider credentials or existing user configuration. The builder installs the
source frozen lockfile and builds before packaging; only extracted package
metadata is stamped. The source package manifests/lockfile remain unchanged.

```sh
cyrus_tooling="$PWD/tooling"
node "$cyrus_tooling/scripts/build-local-artifact.mjs" \
  "$PWD/runtime" 269e051d4a7190c46999ed38773297662dd526f3 \
  "$RUNNER_TEMP/runtime-bundle" "$GITHUB_SHA"

cd "$RUNNER_TEMP/runtime-bundle"
sha256sum --check SHA256SUMS
mkdir "$RUNNER_TEMP/runtime-unpacked"
tar -xzf cyrus-0.2.72-cypack1546.269e051d4a71-test-bundle.tar.gz \
  -C "$RUNNER_TEMP/runtime-unpacked"
cd "$RUNNER_TEMP/runtime-unpacked/cyrus-0.2.72-cypack1546.269e051d4a71-test-bundle"
bash install.sh "$RUNNER_TEMP/runtime-installed"

node "$cyrus_tooling/scripts/verify-local-artifact.mjs" \
  "$RUNNER_TEMP/runtime-unpacked/cyrus-0.2.72-cypack1546.269e051d4a71-test-bundle" \
  "$RUNNER_TEMP/runtime-installed" 269e051d4a7190c46999ed38773297662dd526f3
```

Both output directory and install prefix must be new. The builder uses the
candidate's canonical `release-packages.mjs` graph and `test-cli-artifacts.mjs`
bundle/isolated installer. It records `BUILD.json` with source SHA, supplied CI
workflow SHA, builder SHA256, source lockfile SHA256 and tool versions. The
bundle manifest records all package hashes and the archive has its own checksum.
The verifier checks all 17 expected names, archive sizes/hashes, source identity,
package versions and every installed internal dependency copy resolved from its
consumer. It rejects missing/different stamps and resolution outside the prefix.

The CI rebuild MUST record its own bundle/package hashes. The original local
archive hash `e97592e143037a339495176eea78b0e73c627d701331f141d9d8a1533aba8de7`
applies only to the original bytes; changed timestamps/platform/tooling may
change the rebuild hash. Neither hash is evidence of a published npm version.
Keep original evidence intact and label CI output as a separate rebuild.

## Provenance schemas are deliberately different

Local test packages use exactly:

```json
{
  "cyrusLocalTestArtifact": {
    "sourceSha": "269e051d4a7190c46999ed38773297662dd526f3",
    "kind": "unpublished-test-only"
  }
}
```

Verify this field AND the staged version
`0.2.72-cypack1546.269e051d4a71` for all copies. `cyrusTestRelease` belongs to the
separate registry test-channel release workflow; it includes repository/version/
channel metadata and is not the local artifact stamp. The builder removes that
release stamp from staged packages to avoid ambiguous provenance. Do not accept
an OR between stamps or add a dummy release stamp just to satisfy a smoke test.

**Do not invoke `scripts/test-release-install.mjs` for this job.** It performs a
registry-channel installation and asserts `cyrusTestRelease`. Do not invoke the
release/publishing workflow either. The generated `install.sh` installs the local
17-package tarball set together; npm downloads only external dependencies. Run
`verify-local-artifact.mjs` afterward, followed by the hosted-owned production CLI
startup/discovery smoke and actual connected replay.

## amd64 Docker bootstrap (CI setup only)

The original `e10577f0...` identity is a **multi-platform OCI index**, not an
arm64-only image or the amd64 image config. The earlier local run used arm64;
an Ubuntu amd64 CI run is separate platform evidence.

| Identity | Digest |
| --- | --- |
| OCI index | `sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4` |
| Linux amd64 manifest | `sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834` |
| Linux amd64 config/local image ID | `sha256:59cef0f85ea477b70c4d6428d4a986d4fced461012f46a745fa15d19a523b56f` |
| Linux arm64 manifest | `sha256:d8a4c24744b290bf789d58966a6f2521fc4d8bec36ec02cead6c541147b7d550` |

The independent QA route supplied these pinned registry identities. CI setup
must preload the amd64 manifest, inspect the actual local image, and fail unless
its OS/architecture, ID and absence of declared volumes match:

```sh
docker pull --platform linux/amd64 \
  oven/bun@sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834
docker image inspect \
  sha256:59cef0f85ea477b70c4d6428d4a986d4fced461012f46a745fa15d19a523b56f \
  | jq -e 'length == 1 and .[0].Os == "linux" and .[0].Architecture == "amd64" and .[0].Id == "sha256:59cef0f85ea477b70c4d6428d4a986d4fced461012f46a745fa15d19a523b56f" and ((.[0].Config.Volumes // {}) | length == 0)'
```

Pass the verified **local image ID** as `CYRUS_TEST_SANDBOX_IMAGE` and the local
Unix socket as `CYRUS_TEST_DOCKER_HOST`. Hosted test tooling supports the absolute
`CYRUS_TEST_DOCKER_PATH=/usr/bin/docker` on Ubuntu. Production configuration
already accepts an absolute `dockerPath`; no runtime implementation change is
needed. The original standalone runtime F1 driver hardcodes the macOS binary;
use the hosted CI drivers with their test-only resolver for this joint replay.

Only CI setup preloads the image. Every runtime launch still uses `--pull=never`,
`--network=none`, no mounts, non-root UID, dropped capabilities, no new privileges
and bounded resources. Do not weaken these controls for test portability. No
published minimum runtime version exists; capability discovery remains mandatory.

Packaging changes need syntax/lint, clean-source build, archive inspection and
isolated install/provenance checks. They do not require repeating consumed shared
F1 work. The hosted owner and independent reviewer own the new CI replay.
