import type { GeneratedImageVariants } from './index.js'

export interface LegacyManifestImage {
  readonly hash: string
  readonly width: number
  readonly height: number
  readonly variants: readonly number[]
}

export interface LegacyManifest {
  readonly version: 1
  readonly generated: string
  readonly images: Readonly<Record<string, LegacyManifestImage>>
}

export interface LegacyArtifact {
  readonly slug: string
  readonly width: number
  /** Public URL path, or an absolute URL when baseUrl is supplied. */
  readonly url: string
  /** Relative object key beneath the legacy output directory. */
  readonly objectKey: string
}

export interface LegacyProjectionOptions {
  /** The exact publicPath used to generate the V1 result, for example /variants. */
  publicPath: string
  /** Explicit ISO-8601 UTC timestamp; projection does not consult the clock. */
  generated: string
  /** Optional canonical HTTP(S) origin, without a path, query, or fragment. */
  baseUrl?: string
}

export interface LegacyProjection {
  readonly manifest: LegacyManifest
  readonly artifacts: readonly LegacyArtifact[]
}

export interface LegacyVariantWriterOptions extends LegacyProjectionOptions {
  /** Filesystem root containing the V1 generated variants. */
  sourceDir: string
  /** Filesystem root beneath which only the expected legacy keys are written. */
  outputDir: string
  /** Existing regular objects fail by default; true enables atomic per-file replacement. */
  overwrite?: boolean
}

export interface LegacyVariantWriteResult extends LegacyProjection {
  /** Every public URL published with overwrite: true; callers may invalidate these CDN keys. */
  readonly invalidationUrls: readonly string[]
}

export interface LegacyVariantWriteError extends Error {
  readonly code?: string
  /** Present when overwrite mode failed after publishing one or more earlier keys. */
  readonly invalidationUrls?: readonly string[]
}

/** Project a V1 result into the exact legacy manifest plus validated copy metadata. */
export function projectLegacyManifest(
  result: Readonly<GeneratedImageVariants>,
  options: LegacyProjectionOptions,
): Readonly<LegacyProjection>

/**
 * Copy V1 variants to mutable 16-hex legacy keys under outputDir.
 * A partial overwrite failure carries successful keys on error.invalidationUrls.
 */
export function writeLegacyVariantArtifacts(
  result: Readonly<GeneratedImageVariants>,
  options: LegacyVariantWriterOptions,
): Promise<Readonly<LegacyVariantWriteResult>>
