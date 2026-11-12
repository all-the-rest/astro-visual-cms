import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  EXPECTED_PACKAGE_NAME,
  EXPECTED_REPOSITORY_URL,
  STABLE_VERSION_PATTERN,
  verifyReleaseMetadata,
} from '../scripts/verify-release.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const validPackage = {
  name: EXPECTED_PACKAGE_NAME,
  version: '0.1.0',
  publishConfig: { access: 'public' },
  repository: { type: 'git', url: EXPECTED_REPOSITORY_URL },
}

function runScript(env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-release.mjs')], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

test('release metadata accepts the public package identity and exact repository URL', () => {
  assert.deepEqual(verifyReleaseMetadata(validPackage, 'v0.1.0'), {
    name: EXPECTED_PACKAGE_NAME,
    version: '0.1.0',
    releaseTag: 'v0.1.0',
  })
  assert.equal(verifyReleaseMetadata(validPackage, '0.1.0').version, '0.1.0')
})

test('release metadata rejects a stale package name', () => {
  assert.throws(
    () => verifyReleaseMetadata({ ...validPackage, name: '@astro-visual-cms/editor' }, 'v0.1.0'),
    /package\.json name must remain @all-the\.rest\/astro-visual-cms/,
  )
})

test('release metadata requires public access and provenance', () => {
  assert.throws(
    () => verifyReleaseMetadata({ ...validPackage, publishConfig: {} }, 'v0.1.0'),
    /must publish as a public scoped package/,
  )
  assert.throws(
    () => verifyReleaseMetadata({ ...validPackage, publishConfig: { access: 'public', provenance: false } }, 'v0.1.0'),
    /provenance must not be disabled/,
  )
})

test('release metadata requires the exact GitHub repository URL', () => {
  assert.throws(
    () => verifyReleaseMetadata({ ...validPackage, repository: { type: 'git', url: `${EXPECTED_REPOSITORY_URL}.git` } }, 'v0.1.0'),
    /repository\.url must exactly match/,
  )
})

test('release metadata rejects private packages, missing tags, and mismatched tags', () => {
  assert.throws(
    () => verifyReleaseMetadata({ ...validPackage, private: true }, 'v0.1.0'),
    /must not be private/,
  )
  assert.throws(() => verifyReleaseMetadata(validPackage, ''), /RELEASE_TAG must be set/)
  assert.throws(() => verifyReleaseMetadata(validPackage, 'v0.1.1'), /does not match package version/)
})

test('release metadata accepts stable semantic versions and rejects prerelease or build versions', () => {
  for (const version of ['0.0.1', '0.1.0', '1.2.3', '10.20.30']) {
    assert.match(version, STABLE_VERSION_PATTERN)
    assert.equal(verifyReleaseMetadata({ ...validPackage, version }, `v${version}`).version, version)
  }
  for (const version of ['0.1.0-beta.1', '1.0.0-rc.1', '1.0.0+build.5', '01.0.0', '1.0', 'v1.0.0']) {
    assert.throws(
      () => verifyReleaseMetadata({ ...validPackage, version }, version.startsWith('v') ? version : `v${version}`),
      /stable semantic version/,
      `expected ${version} to be rejected`,
    )
  }
})

test('release metadata rejects GitHub releases marked as prereleases', () => {
  assert.equal(verifyReleaseMetadata(validPackage, 'v0.1.0', { prerelease: false }).version, '0.1.0')
  assert.throws(
    () => verifyReleaseMetadata(validPackage, 'v0.1.0', { prerelease: true }),
    /must not be marked as a prerelease/,
  )
})

test('the release script enforces the stable-only channel for environment inputs', () => {
  const stable = runScript({ RELEASE_TAG: 'v0.1.0', RELEASE_PRERELEASE: 'false' })
  assert.equal(stable.status, 0, stable.stderr)
  assert.match(stable.stdout, /Verified release metadata: @all-the\.rest\/astro-visual-cms@0\.1\.0/)

  const prerelease = runScript({ RELEASE_TAG: 'v0.1.0', RELEASE_PRERELEASE: 'true' })
  assert.notEqual(prerelease.status, 0)
  assert.match(prerelease.stderr, /must not be marked as a prerelease/)

  const invalid = runScript({ RELEASE_TAG: 'v0.1.0', RELEASE_PRERELEASE: 'yes' })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /RELEASE_PRERELEASE must be "true" or "false"/)
})
