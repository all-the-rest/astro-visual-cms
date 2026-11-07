import type { GeneratedImageVariants } from './index.js'

export interface StaticImageProps {
  image: GeneratedImageVariants['images'][number]
  /** Descriptive alt text belongs to the consuming project. */
  alt: string
  sizes?: string
  loading?: 'eager' | 'lazy'
  decoding?: 'async' | 'auto' | 'sync'
  [attribute: string]: unknown
}

declare const StaticImage: (props: StaticImageProps) => unknown
export default StaticImage
