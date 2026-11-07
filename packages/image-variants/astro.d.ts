/// <reference path="./virtual-manifest.d.ts" />

import type { ImageVariantsConfig, GeneratedImageVariants } from './index.js'

export const IMAGE_VARIANTS_VIRTUAL_ID: 'virtual:astro-visual-cms/image-variants'

export interface AstroImageVariantsOptions extends ImageVariantsConfig {}

export interface AstroImageVariantsConfigFile {
  configFile: string
}

export interface AstroImageVariantsIntegration {
  name: string
  hooks: Record<string, (options: any) => unknown>
}

export function imageVariants(options: AstroImageVariantsOptions | AstroImageVariantsConfigFile): AstroImageVariantsIntegration
export { toImageMetadata, toResponsiveImage } from './index.js'
export type { GeneratedImageVariants }
