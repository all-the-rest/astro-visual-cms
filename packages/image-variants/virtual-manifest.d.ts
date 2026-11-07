declare module 'virtual:astro-visual-cms/image-variants' {
  import type { GeneratedImageVariants } from '@astro-visual-cms/image-variants'

  export const imageVariants: Readonly<GeneratedImageVariants>
  export function getImageVariants(slug: string): GeneratedImageVariants['images'][number]

  const manifest: Readonly<GeneratedImageVariants>
  export default manifest
}
