/** Publish staged mutable legacy keys while retaining invalidation data on partial failure. */
export async function publishStagedOverwrites(staged, publishOne) {
  const publishedUrls = []
  try {
    for (const item of staged) {
      await publishOne(item)
      publishedUrls.push(item.url)
    }
    return Object.freeze(publishedUrls)
  } catch (error) {
    if (publishedUrls.length > 0 && error && typeof error === 'object') {
      try {
        Object.defineProperty(error, 'invalidationUrls', {
          value: Object.freeze([...publishedUrls]),
          enumerable: true,
        })
      } catch {
        // Preserve the original publication failure if it cannot carry metadata.
      }
    }
    throw error
  }
}
