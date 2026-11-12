export type ReviewViewport = 'desktop' | 'mobile'

export interface ReviewRoute {
  name: string
  path: string
  expectedTitle: string
  states: Array<'filled' | 'empty'>
  viewports: ReviewViewport[]
  note: string
}

export const uiReviewConfig = {
  outputDir: 'test-results/ui-screenshots',
  viewportSizes: {
    desktop: { width: 1280, height: 900 },
    mobile: { width: 390, height: 844 },
  },
  routes: [
    {
      name: 'mdx-block-editor',
      path: '/?route=block-fixture',
      expectedTitle: 'MDX-Galerien bearbeiten',
      states: ['filled'],
      viewports: ['desktop', 'mobile'],
      note: 'Direct editor deep link selects the synthetic MDX block fixture for visual review.',
    },
  ] satisfies ReviewRoute[],
}
