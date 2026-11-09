import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeLicenseCommand, summarizeRuntimeLicenses } from '../scripts/verify-runtime-licenses.mjs'

test('license report is scoped to the editor package and its production dependencies', () => {
  assert.deepEqual(runtimeLicenseCommand, [
    '--filter', '@astro-visual-cms/editor', 'licenses', 'list', '--prod', '--json',
  ])
})

test('runtime license report accepts only declared, approved production licenses', () => {
  const result = summarizeRuntimeLicenses({
    MIT: [{ name: '@scope/parser', versions: ['1.2.3'], license: 'MIT' }],
    ISC: [{ name: 'yaml', versions: ['2.9.1'], license: 'ISC' }],
    'BSD-3-Clause': [{ name: 'diff', versions: ['9.0.0'], license: 'BSD-3-Clause' }],
  })
  assert.deepEqual(result, {
    packageCount: 3,
    versionCount: 3,
    byLicense: { 'BSD-3-Clause': 1, ISC: 1, MIT: 1 },
  })
})

test('runtime license report rejects unapproved and absent license metadata', () => {
  assert.throws(() => summarizeRuntimeLicenses({ GPL: [{ name: 'copyleft', versions: ['1.0.0'], license: 'GPL' }] }), /unapproved license GPL/)
  assert.throws(() => summarizeRuntimeLicenses({ MIT: [{ name: 'unknown-license', versions: ['1.0.0'] }] }), /missing or mismatched SPDX license metadata/)
  assert.throws(() => summarizeRuntimeLicenses({ MIT: [{ versions: ['1.0.0'], license: 'MIT' }] }), /missing its name/)
})

test('runtime license report rejects malformed or empty reports', () => {
  assert.throws(() => summarizeRuntimeLicenses(null), /invalid runtime license report/)
  assert.throws(() => summarizeRuntimeLicenses({}), /report is empty/)
  assert.throws(() => summarizeRuntimeLicenses({ MIT: 'not a package list' }), /not a package list/)
})
