import { fileURLToPath } from 'node:url'
import { createEditorServer } from './server.mjs'
import { createSampleDevelopmentConfig } from './sample-dev-config.mjs'
import { normalizeAstroBasePath } from './base-path.mjs'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const port = Number(process.env.EDITOR_PORT || 4322)
const sitePort = Number(process.env.ASTRO_PORT || 4321)
const server = createEditorServer({
  ...createSampleDevelopmentConfig(projectRoot),
  port,
  sitePort,
  basePath: normalizeAstroBasePath(process.env.ASTRO_BASE_PATH || '/'),
})

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Sample editor could not start: port ${port} is already in use.`
    : `Sample editor failed to start: ${error.message}`)
  process.exitCode = 1
})

const stop = () => server.close((error) => {
  if (error) {
    console.error(`Sample editor failed to close cleanly: ${error.message}`)
    process.exitCode = 1
  }
})
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
server.listen(port, '127.0.0.1', () => {
  console.log(`Sample editor: http://127.0.0.1:${port}`)
})
