# Releasing and npm Trusted Publishing

The published package identity is fixed:

| Field | Value |
| --- | --- |
| npm package | `@all-the.rest/astro-visual-cms` |
| GitHub repository | `all-the-rest/astro-visual-cms` |
| Publish workflow | `.github/workflows/publish.yml` |
| Workflow filename for npm | `publish.yml` |
| Workflow trigger | GitHub Release `published` |
| npm access | public (`publishConfig.access`) |
| Provenance | automatic through npm OIDC |

`package.json` must keep `repository.url` exactly
`https://github.com/all-the-rest/astro-visual-cms`. npm compares this value with
the GitHub repository during OIDC publishing, and a mismatch rejects the
publish. `scripts/verify-release.mjs` also fails when the package name, public
access, repository URL, provenance setting, stable version format, prerelease
flag, or release tag drifts.

The workflow uses GitHub-hosted `ubuntu-24.04` runners. The `verify` job has no
OIDC permission; only the separate `publish` job receives `id-token: write`.
The publish job pins npm CLI 11.19.0 (trusted publishing requires >= 11.5.1)
and requires Node.js >= 22.14.0. It does not use an npm token or secret.

## Preconditions

1. The release commit is merged to the protected default branch and CI is green.
2. `.github/workflows/publish.yml` exists on the default branch. GitHub only
   starts release-triggered workflows that are present there.
3. `package.json` has the intended new stable version, and the release tag
   matches it. Both `0.1.0` and `v0.1.0` are accepted for version `0.1.0`; use
   `v0.1.0` by convention.
4. `pnpm run verify` and `pnpm run pack:smoke` pass. The publish workflow reruns
   both before it publishes.

The publish job does not trust the tag checkout on its own. Before tool setup,
`npm install`, or `npm publish`, an inline git-only gate fetches the
`github.event.repository.default_branch` from the same repository with complete
history and runs `git merge-base --is-ancestor` against the checked-out tag
commit. The checked-out `HEAD` must also equal the release event's `GITHUB_SHA`,
so a tag moved after the event was queued is rejected. A failed or incomplete
fetch, a missing default branch, a shallow checkout that cannot be completed, a
mismatched commit, or an unmerged tag aborts the job. The gate runs no
checked-out code; `actions/checkout` uses `persist-credentials: false`.

## Stable-only release channel

This workflow publishes stable versions only. `scripts/verify-release.mjs`
rejects prerelease and build versions (`1.2.3-rc.1`, `1.2.3+build.5`) and rejects
GitHub Releases marked as prereleases. There is no npm dist-tag, prerelease
channel, or `npm stage publish` path configured. To ship a prerelease, add an
explicitly reviewed channel first; do not bypass the metadata check.

## One-time bootstrap: seed the package manually

npm cannot store Trusted Publisher settings for a package that does not exist,
so the first public version must be published manually with the maintainer's
authenticated npm CLI.

1. Confirm the npm identity and scope access:

   ```sh
   npm whoami
   npm access list packages @all-the.rest
   ```

   Expected maintainer: `florian.reisinger.at`.

2. Use a clean checkout of the reviewed release commit. Do not publish from a
   dirty worktree:

   ```sh
   git status --porcelain
   pnpm install --frozen-lockfile
   pnpm run verify
   pnpm run pack:smoke
   npm pack --dry-run
   ```

3. Publish the seed version (currently `0.1.0`) interactively. This is the only
   manual publish:

   ```sh
   npm publish --access public
   ```

   Complete the npm 2FA prompt if requested. Do **not** create a GitHub Release
   for this seed version: a `release: published` event would start the workflow
   and fail because that version already exists. A plain git tag such as
   `v0.1.0` without a published GitHub Release is harmless.

4. Verify the seed package:

   ```sh
   npm view @all-the.rest/astro-visual-cms@0.1.0 name version repository.url dist.tarball
   ```

## Configure the Trusted Publisher in the browser

Immediately after the seed publish, open the package on npmjs.com:

**Packages → `@all-the.rest/astro-visual-cms` → Settings → Trusted
Publisher → Add trusted publisher → GitHub Actions**

Enter these exact values:

| npm field | Value |
| --- | --- |
| Organization or user | `all-the-rest` |
| Repository | `astro-visual-cms` |
| Workflow filename | `publish.yml` |
| Environment name | leave empty |
| Allowed actions | enable **Allow npm publish** |

The filename is case-sensitive and must include `.yml`; enter only the filename,
not `.github/workflows/publish.yml`. Leave the environment empty because the
workflow does not declare a GitHub environment. Trusted publisher connections
created after 2026-09-03 allow `npm stage publish` by default; direct
`npm publish` only works when **Allow npm publish** is enabled. Leave
**Allow npm dist-tag** disabled unless release automation explicitly needs it.

npm does not validate these fields when saving them. A typo only appears as an
authentication failure during the next publish.

## First OIDC publish window

A newly created Trusted Publisher configuration must complete its first
successful publish within **2 days**. That first publish validates and binds the
configuration to the repository identity. If it expires, delete the
configuration, create it again, and publish within a new 2-day window.

Create a new version immediately after saving the configuration; do not reuse
the already-published seed version. The normal path is:

1. Bump `package.json` to the next version (for example `0.1.0` → `0.1.1`) on
   the default branch and let CI pass.
2. Tag that commit (`v0.1.1`) and create a GitHub Release from the tag.
3. Publishing the GitHub Release triggers `.github/workflows/publish.yml`.
   The `verify` job runs metadata checks, `pnpm run verify`, and
   `pnpm run pack:smoke`; the `publish` job then runs
   `npm publish --access public` through OIDC.
4. Confirm the release on npm: it must show the expected version and provenance,
   and `npm view @all-the.rest/astro-visual-cms@0.1.1 dist.attestations` must
   return attestation data.

Do not create a release for a version that is already on npm.

## Ongoing releases

1. Merge the version bump and release notes through the normal pull request; CI
   must be green.
2. Create the tag and publish a GitHub Release for that tag. Do **not** mark the
   release as a prerelease; the metadata check rejects prereleases.
3. Observe the `verify` and `publish` jobs in the release workflow.
4. Verify the npm version, tarball contents, and provenance.

Keep the workflow filename and repository identity stable. Existing trusted
publisher connections cannot be edited; if the filename changes, delete the
connection and create a new one, then complete a new first publish within the
2-day window.

After the first OIDC publish succeeds, harden token access in the npm package
settings under **Publishing access**, for example **Require two-factor
authentication and disallow tokens**. Do not add long-lived npm publish tokens
to repository secrets or workflows.

## Troubleshooting

- `ENEEDAUTH` or `Unable to authenticate`: verify the workflow runs from
  GitHub-hosted runners with `id-token: write`, and that the npm trusted
  publisher fields match exactly (`all-the-rest`, `astro-visual-cms`,
  `publish.yml`, no environment).
- `You cannot publish over the previously published versions`: bump the package
  version; never retry a release for an existing version.
- Publish succeeds but provenance is missing: provenance requires OIDC, a public
  package, and a public repository.
- Trusted publisher shows as unvalidated: the 2-day window expired; delete and
  recreate the configuration, then publish a new version immediately.
