#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateImageVariants } from './core.mjs'
import { loadImageVariantsConfig } from './config.mjs'

const HELP = `Usage: image-variants generate --config <file>

Generate static WebP variants from a JSON image-variants config and write the
technical result manifest as JSON to stdout.
`

/** CLI entry point, also exported for focused tests and build-script use. */
export async function runCli(argv = process.argv.slice(2), {
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
      stdout.write(HELP)
      return 0
    }
    if (argv[0] !== 'generate' || argv.length !== 3 || argv[1] !== '--config') {
      stderr.write(HELP)
      return 2
    }
    const configPath = path.resolve(cwd, argv[2])
    const config = await loadImageVariantsConfig(configPath)
    const result = await generateImageVariants(config)
    stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    stderr.write(`image-variants: ${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCli()
}
