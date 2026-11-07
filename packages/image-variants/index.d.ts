export interface SourceImageEntry {
  slug: string
  /** JPEG basename under sourceRoot. */
  file: string
  format: 'jpeg'
  maxBytes: number
  maxPixels: number
  /** Strictly increasing requested output widths. */
  widths: number[]
}

export interface SourceImageManifest {
  version: 1
  images: SourceImageEntry[]
}

export interface ImageVariantsConfig {
  manifest: SourceImageManifest
  sourceRoot: string
  outputDir: string
  publicPath?: string
}

export interface ImageVariant {
  url: string
  format: 'webp'
  width: number
  height: number
}

export interface GeneratedImageVariants {
  version: 1
  transformNamespace: string
  images: Array<{
    slug: string
    width: number
    height: number
    variants: ImageVariant[]
  }>
}

export interface ImageMetadata {
  src: string
  width: number
  height: number
  format: 'webp'
}

export interface ResponsiveImageMetadata extends ImageMetadata {
  srcset: string
  sizes: string
}

export const IMAGE_VARIANTS_LIMITS: Readonly<{
  maxImages: 16
  maxSourceBytes: 5242880
  maxSourcePixels: 10000000
  maxVariantsPerImage: 8
  maxVariantWidth: 8192
}>

export const IMAGE_VARIANTS_TRANSFORM_NAMESPACE: string

export function validateImageVariantsManifest(manifest: unknown): Readonly<SourceImageManifest>
export function resolveImageVariantsConfig(config: ImageVariantsConfig, options?: { baseDir?: string }): Readonly<{
  manifest: Readonly<SourceImageManifest>
  sourceRoot: string
  outputDir: string
  publicPath: string
}>
export function loadImageVariantsConfig(configFile: string, options?: { baseDir?: string }): Promise<Readonly<{
  manifest: Readonly<SourceImageManifest>
  sourceRoot: string
  outputDir: string
  publicPath: string
}>>
export function generateImageVariants(config: ImageVariantsConfig): Promise<Readonly<GeneratedImageVariants>>
export function toImageMetadata(image: GeneratedImageVariants['images'][number]): Readonly<ImageMetadata>
export function toResponsiveImage(
  image: GeneratedImageVariants['images'][number],
  options?: { sizes?: string },
): Readonly<ResponsiveImageMetadata>
export function createSourceJpegImportGuard(
  manifest: SourceImageManifest | (() => SourceImageManifest),
  sourceRoot: string | (() => string),
): {
  name: string
  enforce: 'pre'
  resolveId(source: string, importer?: string): Promise<undefined>
}
