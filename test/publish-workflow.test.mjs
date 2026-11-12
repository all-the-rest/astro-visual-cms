import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/publish.yml')
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Release Gate Test',
  GIT_AUTHOR_EMAIL: 'release-gate@example.invalid',
  GIT_COMMITTER_NAME: 'Release Gate Test',
  GIT_COMMITTER_EMAIL: 'release-gate@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV, ...env },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`)
  return result.stdout.trim()
}

async function loadWorkflow() {
  return parse(await readFile(WORKFLOW_PATH, 'utf8'))
}

async function readGateScript(jobName = 'publish') {
  const workflow = await loadWorkflow()
  const step = workflow.jobs[jobName].steps.find((candidate) => candidate.id === 'release-gate')
  assert.ok(step?.run, `${jobName} job must contain the id: release-gate shell step`)
  return step.run
}

function assertGateAvoidsCheckedOutTooling(gate) {
  assert.match(gate.run, /set -euo pipefail/)
  assert.match(gate.run, /git merge-base --is-ancestor/)
  assert.match(gate.run, /refs\/remotes\/release-gate\//)
  assert.match(gate.run, /--no-tags/)
  assert.match(gate.run, /--unshallow/)
  assert.match(gate.run, /GITHUB_SHA/)
  assert.doesNotMatch(gate.run, /node\b|npm\b|pnpm\b|scripts\//, 'the gate must not execute checked-out tooling')
  assert.equal(gate['continue-on-error'], undefined, 'a failing gate must fail the job')
}

/**
 * Builds a bare origin plus a checkout of the release tag. `tagOn` decides whether
 * the tag points at the default-branch tip or at an unmerged feature commit.
 */
async function makeRepository(tagOn = 'main') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'publish-gate-'))
  const origin = path.join(directory, 'origin.git')
  const seed = path.join(directory, 'seed')
  const checkout = path.join(directory, 'checkout')
  await mkdir(seed)
  git(directory, ['init', '--quiet', '--bare', origin])
  git(seed, ['init', '--quiet', '--initial-branch=main'])
  await writeFile(path.join(seed, 'content.txt'), 'default branch\n')
  git(seed, ['add', 'content.txt'])
  git(seed, ['commit', '--quiet', '-m', 'default branch commit'])
  const defaultCommit = git(seed, ['rev-parse', 'HEAD'])
  git(seed, ['remote', 'add', 'origin', origin])
  git(seed, ['push', '--quiet', 'origin', 'main'])

  git(seed, ['checkout', '--quiet', '-b', 'feature'])
  await writeFile(path.join(seed, 'content.txt'), 'unmerged feature\n')
  git(seed, ['commit', '--quiet', '--all', '-m', 'unmerged feature commit'])
  const featureCommit = git(seed, ['rev-parse', 'HEAD'])
  git(seed, ['push', '--quiet', 'origin', 'feature'])
  git(seed, ['tag', 'v0.1.0', tagOn === 'main' ? defaultCommit : featureCommit])
  git(seed, ['push', '--quiet', 'origin', 'v0.1.0'])

  git(directory, ['clone', '--quiet', origin, checkout])
  git(checkout, ['checkout', '--quiet', 'v0.1.0'])

  const gitConfig = path.join(directory, 'gitconfig')
  await writeFile(gitConfig, [
    `[url "file://${origin}"]`,
    '\tinsteadOf = https://x-access-token:test-token@github.com/test/repo.git',
    '',
  ].join('\n'))

  return { directory, origin, checkout, gitConfig, defaultCommit, featureCommit }
}

function runGate(script, repository, overrides = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd: repository.checkout,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...GIT_ENV,
      GIT_CONFIG_GLOBAL: repository.gitConfig,
      GITHUB_REPOSITORY: 'test/repo',
      GITHUB_TOKEN: 'test-token',
      GITHUB_SHA: repository.defaultCommit,
      RELEASE_TAG: 'v0.1.0',
      DEFAULT_BRANCH: 'main',
      ...overrides,
    },
  })
}

test('publish workflow gates the OIDC job before any checked-out code or npm install', async () => {
  const workflow = await loadWorkflow()
  const steps = workflow.jobs.publish.steps
  const indexOf = (predicate, label) => {
    const index = steps.findIndex(predicate)
    assert.notEqual(index, -1, `missing publish step: ${label}`)
    return index
  }

  const checkoutIndex = indexOf((step) => /^Check out/.test(step.name || ''), 'checkout')
  const gateIndex = indexOf((step) => step.id === 'release-gate', 'release gate')
  const setupIndex = indexOf((step) => /^Set up Node/.test(step.name || ''), 'node setup')
  const metadataIndex = indexOf((step) => step.name === 'Verify release metadata', 'metadata check')
  const installIndex = indexOf((step) => /npm install --prefix/.test(step.run || ''), 'npm install')
  const publishIndex = indexOf((step) => step.name === 'Publish package with provenance', 'npm publish')

  assert.equal(gateIndex, checkoutIndex + 1, 'the branch gate must run immediately after checkout')
  assert.ok(gateIndex < setupIndex, 'the branch gate must run before tool setup')
  assert.ok(gateIndex < metadataIndex, 'the branch gate must run before the checked-out metadata script')
  assert.ok(gateIndex < installIndex, 'the branch gate must run before npm install')
  assert.ok(gateIndex < publishIndex, 'the branch gate must run before npm publish')
  assert.ok(installIndex < publishIndex, 'npm must be installed and checked before publishing')
  const cli = '$RUNNER_TEMP/trusted-npm/node_modules/npm/bin/npm-cli.js'
  assert.ok(steps[installIndex].run.includes(`node "${cli}" --version`))
  assert.match(steps[installIndex].run, /\[ "\$npm_version" = "11\.19\.0" \]/)
  assert.equal(steps[publishIndex].run, `node "${cli}" publish --access public`)

  const checkout = steps[checkoutIndex]
  assert.equal(checkout.with['fetch-depth'], 0, 'the tag checkout needs complete history')
  assert.equal(checkout.with['persist-credentials'], false, 'the checkout must not persist the GitHub token')
  assert.equal(checkout.with.ref, 'refs/tags/${{ github.event.release.tag_name }}', 'the checkout must use the unambiguous tag ref')

  const gate = steps[gateIndex]
  assertGateAvoidsCheckedOutTooling(gate)

  assert.equal(workflow.env.RELEASE_TAG, '${{ github.event.release.tag_name }}')
  assert.equal(workflow.env.RELEASE_PRERELEASE, '${{ github.event.release.prerelease }}')
  assert.equal(workflow.env.DEFAULT_BRANCH, '${{ github.event.repository.default_branch }}')
})

test('an isolated preflight gate runs before any job executes release-controlled code', async () => {
  const workflow = await loadWorkflow()
  const jobs = workflow.jobs

  assert.ok(jobs.preflight, 'the workflow must define a dedicated preflight job')
  assert.ok(jobs.verify, 'the workflow must keep the verify job')
  assert.ok(jobs.publish, 'the workflow must keep the publish job')

  // Fail closed: no job may be skipped with an `if:` expression, so a successful
  // run necessarily evaluates the gate before anything else.
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job.if, undefined, `${name} must not be conditionally skipped`)
  }

  // The preflight job executes the gate first and nothing release-controlled
  // before it: only the pinned checkout action, then the shell gate itself.
  const preflightSteps = jobs.preflight.steps
  assert.equal(preflightSteps.length, 2, 'preflight must contain only checkout and the release gate')
  const checkout = preflightSteps[0]
  assert.match(checkout.name || '', /^Check out/, 'preflight must start with a checkout')
  assert.equal(checkout.uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1')
  assert.equal(checkout.with?.ref, 'refs/tags/${{ github.event.release.tag_name }}')
  assert.equal(checkout.with?.['fetch-depth'], 0)
  assert.equal(checkout.with?.['persist-credentials'], false)
  const gate = preflightSteps[1]
  assert.equal(gate.id, 'release-gate', 'the gate must immediately follow the checkout')
  assertGateAvoidsCheckedOutTooling(gate)

  // Dependent jobs cannot start before the gate succeeds.
  assert.equal(jobs.verify.needs, 'preflight', 'verify must depend on the preflight gate')
  assert.deepEqual(jobs.publish.needs, ['preflight', 'verify'], 'publish must depend on preflight and verify')

  // Verify must not silently reintroduce release-controlled execution before a
  // gate: its first step is the pinned tag checkout and the ancestry gate has
  // already completed in the preflight job.
  assert.match(jobs.verify.steps[0].name || '', /^Check out/, 'verify must start with its own explicit tag checkout')
  assert.equal(jobs.verify.steps[0].with?.ref, 'refs/tags/${{ github.event.release.tag_name }}')
  assert.equal(jobs.verify.steps[0].with?.['persist-credentials'], false)
  const verifyTagGuard = jobs.verify.steps[1]
  assert.match(verifyTagGuard.name || '', /^Reject a moved/, 'verify must re-check the checked-out commit before running release code')
  assert.match(verifyTagGuard.run, /git rev-parse/, 'the verify tag guard must use git plumbing only')
  assert.match(verifyTagGuard.run, /GITHUB_SHA/)
  assert.doesNotMatch(verifyTagGuard.run, /node\b|npm\b|pnpm\b|scripts\//, 'the verify tag guard must not execute checked-out tooling')
  assert.equal(verifyTagGuard['continue-on-error'], undefined, 'a mismatched checkout must fail the verify job')

  // Defense in depth: publish keeps its own identical gate before setup/install.
  assert.equal(
    await readGateScript('preflight'),
    await readGateScript('publish'),
    'the preflight and publish gates must stay byte-identical so the duplicated defense cannot drift',
  )
})

test('all workflow actions are pinned to full commit SHAs', async () => {
  const workflow = await loadWorkflow()
  const actions = []
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps || []) {
      if (step.uses) actions.push(step.uses)
    }
  }
  assert.ok(actions.length > 0)
  for (const action of actions) {
    assert.match(action, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/, `${action} is not pinned to a full commit SHA`)
  }
})

test('the release gate accepts a tag commit reachable from the default branch', async (t) => {
  const repository = await makeRepository('main')
  t.after(() => rm(repository.directory, { recursive: true, force: true }))
  const result = runGate(await readGateScript(), repository)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /reachable from main/)
})

test('the release gate rejects a tag that points at an unmerged commit', async (t) => {
  const repository = await makeRepository('feature')
  t.after(() => rm(repository.directory, { recursive: true, force: true }))
  const result = runGate(await readGateScript(), repository, { GITHUB_SHA: repository.featureCommit })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /is not reachable from the protected default branch main/)
})

test('the release gate rejects a moved or mismatched release tag', async (t) => {
  const repository = await makeRepository('feature')
  t.after(() => rm(repository.directory, { recursive: true, force: true }))
  const result = runGate(await readGateScript(), repository, { GITHUB_SHA: repository.defaultCommit })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match release event commit/)
})

test('the verify checkout guard rejects a moved tag before release code runs', async (t) => {
  const repository = await makeRepository('feature')
  t.after(() => rm(repository.directory, { recursive: true, force: true }))
  const workflow = await loadWorkflow()
  const step = workflow.jobs.verify.steps.find((candidate) => candidate.id === 'release-checkout-check')
  assert.ok(step?.run, 'verify must declare the id: release-checkout-check guard')
  const result = spawnSync('bash', ['-c', step.run], {
    cwd: repository.checkout,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, GITHUB_SHA: repository.defaultCommit },
  })
  assert.notEqual(result.status, 0, 'a tag moved away from the preflighted commit must stop verify before Node runs')
  assert.match(result.stderr, /does not match the preflighted release commit/)
})

test('the preflight gate fails closed before dependent jobs can run release code', async (t) => {
  const repository = await makeRepository('feature')
  t.after(() => rm(repository.directory, { recursive: true, force: true }))
  const result = runGate(await readGateScript('preflight'), repository, { GITHUB_SHA: repository.featureCommit })
  assert.notEqual(result.status, 0, 'an unmerged release commit must stop the workflow before verify runs')
  assert.match(result.stderr, /is not reachable from the protected default branch main/)
})

test('the release gate fails closed on invalid SHAs and missing default branches', async (t) => {
  const repository = await makeRepository('main')
  t.after(() => rm(repository.directory, { recursive: true, force: true }))
  const script = await readGateScript()

  const invalidSha = runGate(script, repository, { GITHUB_SHA: 'not-a-sha' })
  assert.notEqual(invalidSha.status, 0)
  assert.match(invalidSha.stderr, /GITHUB_SHA must be the tagged 40-character commit SHA/)

  const missingBranch = runGate(script, repository, { DEFAULT_BRANCH: 'does-not-exist' })
  assert.notEqual(missingBranch.status, 0)
})
