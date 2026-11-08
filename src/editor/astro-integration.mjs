/**
 * This integration intentionally adds no routes, client code, or server hooks.
 * It only constrains Astro's own listener when running the development command.
 */
export function createLoopbackDevIntegration() {
  return {
    name: 'astro-visual-cms-loopback-dev-boundary',
    hooks: {
      'astro:config:setup'({ command, updateConfig }) {
        if (command === 'dev') updateConfig({ server: { host: '127.0.0.1' } })
      },
    },
  }
}
