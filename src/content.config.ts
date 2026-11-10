import { file, glob } from 'astro/loaders'
import { defineCollection } from 'astro:content'
import { z } from 'astro/zod'

import { REISINGER_SAMPLE_TAGS } from './data/reisinger-sample-tags'

const editorialSample = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/reisinger-like' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    date: z.coerce.date(),
    heroImage: z.string(),
    tags: z.array(z.enum(REISINGER_SAMPLE_TAGS)).optional(),
  }),
})

const sampleSummary = defineCollection({
  loader: file('src/content/reisinger-like/summary.json'),
  schema: z.object({
    summary: z.string(),
    reviewCount: z.number(),
  }),
})

export const collections = { editorialSample, sampleSummary }
