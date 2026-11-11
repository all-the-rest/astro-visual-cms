import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXPECTED_PACKAGE_NAME = '@all-the.rest/astro-visual-cms'
export const EXPECTED_REPOSITORY_URL = 'https://github.com/all-the-rest/astro-visual-cms'
export const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

export function verifyReleaseMetadata(pkg, releaseTag, { prerelease = false } = {}) {
  assert.equal(pkg?.name, EXPECTED_PACKAGE_NAME, `package.json name must remain ${EXPECTED_PACKAGE_NAME}.`)
  assert.equal(pkg?.publishConfig?.access, 'public', 'package.json must publish as a public scoped package.')
  assert.notEqual(pkg?.publishConfig?.provenance, false, 'npm provenance must not be disabled.')
  assert.equal(pkg?.repository?.url, EXPECTED_REPOSITORY_URL,
    `package.json repository.url must exactly match ${EXPECTED_REPOSITORY_URL} for npm OIDC publishing.`)
  assert.equal(pkg?.private, undefined, 'package.json must not be private for a public release.')
  assert.equal(typeof pkg?.version, 'string', 'package.json must declare a version.')
  assert.match(pkg.version, STABLE_VERSION_PATTERN,
    `package.json version ${pkg.version} must be a stable semantic version such as 1.2.3; ` +
    'this workflow publishes stable versions only and has no npm prerelease channel.')
  assert.notEqual(prerelease, true,
    'The GitHub release must not be marked as a prerelease; this workflow publishes stable versions only.')

  assert.ok(releaseTag, 'RELEASE_TAG must be set to the GitHub release tag.')
  assert.ok(
    releaseTag === pkg.version || releaseTag === `v${pkg.version}`,
    `Release tag ${releaseTag} does not match package version ${pkg.version} (expected ${pkg.version} or v${pkg.version}).`,
  )

  return {
    name: pkg.name,
    version: pkg.version,
    releaseTag,
  }
}

async function run() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const prereleaseValue = process.env.RELEASE_PRERELEASE?.trim() ?? ''
  assert.ok(
    prereleaseValue === '' || prereleaseValue === 'true' || prereleaseValue === 'false',
    `RELEASE_PRERELEASE must be "true" or "false" when set; received ${JSON.stringify(prereleaseValue)}.`,
  )
  const release = verifyReleaseMetadata(pkg, process.env.RELEASE_TAG?.trim(), { prerelease: prereleaseValue === 'true' })
  console.log(`Verified release metadata: ${release.name}@${release.version} for tag ${release.releaseTag}.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await run()
  } catch (error) {
    console.error(`Release metadata check failed: ${error.message}`)
    process.exitCode = 1
  }
}
