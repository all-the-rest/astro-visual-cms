/** Normalize the trusted Astro base path used by both Astro and the editor. */
export function normalizeAstroBasePath(value = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('//') ||
      /[?#%\\\s\u0000-\u001f]/.test(value)) {
    throw new TypeError('ASTRO_BASE_PATH must be a safe absolute path without query, hash, encoding, or traversal.')
  }

  const segments = value.split('/').filter(Boolean)
  if (segments.some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) {
    throw new TypeError('ASTRO_BASE_PATH must contain only safe, non-traversal path segments.')
  }

  return segments.length === 0 ? '/' : `/${segments.join('/')}/`
}

/** Astro's config uses a slashless suffix; URLs in the editor use trailing slash. */
export function astroBaseConfigValue(basePath) {
  return basePath === '/' ? '/' : basePath.slice(0, -1)
}
