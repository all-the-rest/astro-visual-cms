import { defineConfig } from 'astro/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SOURCE_MANIFEST } from './source-manifest.mjs'
import { createSourceJpegImportGuard } from '../../scripts/sharp-static-variants.mjs'

const fixtureRoot = fileURLToPath(new URL('.', import.meta.url))
const root = process.env.SHARP_TEST_APP_ROOT || fixtureRoot
if (!path.isAbsolute(root)) throw new Error('SHARP_TEST_APP_ROOT must be an absolute path when provided.')
const directoryVariables = [
  ['publicDir', 'SHARP_TEST_PUBLIC_DIR'],
  ['outDir', 'SHARP_TEST_OUT_DIR'],
  ['cacheDir', 'SHARP_TEST_CACHE_DIR'],
]
const configuredDirectories = directoryVariables.map(([property, variable]) => [property, process.env[variable]])
const configuredCount = configuredDirectories.filter(([, value]) => value).length
if (configuredCount !== 0 && configuredCount !== configuredDirectories.length) {
  throw new Error('All SHARP_TEST_* directories must be set together for the synthetic build.')
}
for (const [, value] of configuredDirectories) {
  if (value && !path.isAbsolute(value)) throw new Error('SHARP_TEST_* directories must be absolute paths.')
}

export default defineConfig({
  root,
  ...(configuredCount === configuredDirectories.length
    ? Object.fromEntries(configuredDirectories)
    : {}),
  vite: {
    plugins: [createSourceJpegImportGuard(SOURCE_MANIFEST)],
  },
})
