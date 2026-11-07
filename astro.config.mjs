import mdx from '@astrojs/mdx'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMAGE_MANIFEST } from './src/lib/demo-image-manifest.mjs'
import { createImageManifestImportGuard } from './src/lib/vite-image-import-guard.mjs'

// This project intentionally pins Astro's root to the directory containing this
// config. A different root must update the resolver's injected asset root too.
const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url))
const IMAGE_ROOT = path.join(PROJECT_ROOT, 'public', 'images')

export default defineConfig({
  root: PROJECT_ROOT,
  integrations: [mdx()],
  vite: {
    define: {
      __ASTRO_VISUAL_CMS_IMAGE_ROOT__: JSON.stringify(IMAGE_ROOT),
    },
    plugins: [tailwindcss(), createImageManifestImportGuard(IMAGE_MANIFEST)],
  },
})
