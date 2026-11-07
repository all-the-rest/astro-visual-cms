import mdx from '@astrojs/mdx'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

function fixtureImageImportGuard() {
  return {
    name: 'fixture-image-import-guard',
    enforce: 'pre',
    resolveId(source) {
      if (/noise-fixture-0[1-3]\.jpg(?:\?.*)?$/.test(source)) {
        throw new Error('The slug-image spike must not resolve fixture JPEGs as Vite image modules.')
      }
    },
  }
}

export default defineConfig({
  integrations: [mdx()],
  vite: {
    plugins: [tailwindcss(), fixtureImageImportGuard()],
  },
})
