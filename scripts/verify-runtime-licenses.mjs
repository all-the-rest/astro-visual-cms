import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const approvedLicenses = new Set(['MIT', 'ISC', 'BSD-3-Clause'])
export const runtimeLicenseCommand = Object.freeze([
  '--filter', '@all-the.rest/astro-visual-cms', 'licenses', 'list', '--prod', '--json',
])

export function summarizeRuntimeLicenses(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('pnpm returned an invalid runtime license report.')
  }

  const counts = new Map()
  let packageCount = 0
  let versionCount = 0
  const violations = []

  for (const [bucket, packages] of Object.entries(report)) {
    if (!Array.isArray(packages)) {
      violations.push(`license bucket ${bucket} is not a package list`)
      continue
    }
    for (const item of packages) {
      packageCount += 1
      const name = typeof item?.name === 'string' && item.name ? item.name : '<unnamed package>'
      const versions = Array.isArray(item?.versions) ? item.versions : []
      versionCount += versions.length
      if (!approvedLicenses.has(bucket)) violations.push(`${name}: unapproved license ${bucket}`)
      if (item?.license !== bucket) violations.push(`${name}: missing or mismatched SPDX license metadata`)
      if (versions.length === 0 || versions.some((version) => typeof version !== 'string' || !version)) {
        violations.push(`${name}: missing resolved version metadata`)
      }
      if (name === '<unnamed package>') violations.push('package is missing its name')
      counts.set(bucket, (counts.get(bucket) || 0) + 1)
    }
  }

  if (packageCount === 0) violations.push('runtime dependency report is empty')
  if (violations.length) throw new Error(violations.join('\n'))

  return {
    packageCount,
    versionCount,
    byLicense: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
  }
}

function run() {
  const result = spawnSync('pnpm', runtimeLicenseCommand, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'pnpm licenses list failed.\n')
    process.exitCode = result.status || 1
    return
  }

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    throw new Error('pnpm licenses list returned invalid JSON.')
  }
  const summary = summarizeRuntimeLicenses(report)
  const licenseSummary = Object.entries(summary.byLicense).map(([license, count]) => `${license}: ${count}`).join(', ')
  console.log(`Verified ${summary.packageCount} production dependency entries (${summary.versionCount} resolved versions): ${licenseSummary}.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run()
  } catch (error) {
    console.error(`Runtime dependency license check failed: ${error.message}`)
    process.exitCode = 1
  }
}
