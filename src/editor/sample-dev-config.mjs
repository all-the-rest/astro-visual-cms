import path from 'node:path'

export const SAMPLE_DRAFT_TEXT = 'This fictional sentence is the one supported visual draft in the sample.'

export function createSampleDevelopmentConfig(projectRoot) {
  const root = path.resolve(projectRoot)
  return {
    fixturePath: path.join(root, 'src/pages/fixture.mdx'),
    projectRoot: root,
    contentConfigPath: 'src/content.config.ts',
    previewRoutes: [
      { id: 'home', label: 'Startseite', path: '/' },
      { id: 'fixture', label: 'Fixture', path: '/fixture/', cacheBustOnRevision: true },
      { id: 'showcase', label: 'Synthetischer Showcase', path: '/reisinger-sample/editorial/showcase/', cacheBustOnRevision: true },
    ],
    markdownDraftTargets: [{
      id: 'showcase-prose',
      instanceId: 'showcase-prose-one',
      projectRoot: root,
      filePath: path.join(root, 'src/content/reisinger-like/editorial/showcase/index.mdx'),
      text: SAMPLE_DRAFT_TEXT,
    }],
  }
}
