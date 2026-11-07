import path from 'node:path'
import { defineConfig } from 'astro/config'
import { imageVariants } from '@astro-visual-cms/image-variants/astro'

const appRoot = process.env.IMAGE_VARIANTS_TEST_APP_ROOT
if (!appRoot || !path.isAbsolute(appRoot)) {
  throw new Error('IMAGE_VARIANTS_TEST_APP_ROOT must name the script-owned synthetic app root.')
}

export default defineConfig({
  root: appRoot,
  publicDir: path.join(appRoot, 'public'),
  outDir: path.join(appRoot, 'dist'),
  cacheDir: path.join(appRoot, '.astro'),
  integrations: [imageVariants({ configFile: path.join(appRoot, 'image-variants.json') })],
})
