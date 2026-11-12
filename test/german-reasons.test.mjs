import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createContext, Script } from 'node:vm'
import { discoverContentCollections } from '../src/editor/collection-discovery.mjs'
import { createCollectionRuntime, publicCollectionState } from '../src/editor/collection-runtime.mjs'

const UI_PATH = new URL('../src/editor/index.html', import.meta.url)
const SETUP_MESSAGES = new Set([
  'Collection discovery requires an absolute trusted projectRoot.',
  'Collection discovery requires a trusted contentConfigPath.',
  'The trusted projectRoot must be an existing directory without symlink traversal.',
])

async function loadGermanReason() {
  const html = await readFile(UI_PATH, 'utf8')
  const script = html.match(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script, 'The editor must include its browser client.')
  const start = script.indexOf('const GERMAN_REASON_TRANSLATIONS')
  const end = script.indexOf('\n      const siteOrigin', start)
  assert.ok(start >= 0 && end > start, 'The German reason catalog must stay addressable.')
  const context = createContext({})
  new Script(`${script.slice(start, end)}
this.germanReason = germanReason;
this.withoutTerminalPunctuation = withoutTerminalPunctuation;
this.translations = GERMAN_REASON_TRANSLATIONS;`).runInContext(context)
  return {
    germanReason: context.germanReason,
    withoutTerminalPunctuation: context.withoutTerminalPunctuation,
    translations: context.translations,
  }
}

function staticSentenceMessages(source) {
  return [...source.matchAll(/'([A-Z][^'\n]{10,}[.!])'/g)].map((match) => match[1])
}

test('every static collection discovery and runtime reason has a German translation', async () => {
  const { germanReason, translations } = await loadGermanReason()
  for (const file of ['collection-discovery.mjs', 'collection-runtime.mjs']) {
    const source = await readFile(new URL(`../src/editor/${file}`, import.meta.url), 'utf8')
    for (const message of staticSentenceMessages(source)) {
      if (SETUP_MESSAGES.has(message)) continue
      assert.ok(translations[message], `${file} reason must have a German translation: ${message}`)
      const german = germanReason(message)
      assert.notEqual(german, message)
      assert.doesNotMatch(german, /^Nicht übersetzte Ursache:/)
    }
  }
})

test('dynamic field, creation, limit, and API reasons are translated without dropping details', async () => {
  const { germanReason, withoutTerminalPunctuation } = await loadGermanReason()
  const policyMessage = 'Existing-source replacement is blocked by policy; no changes were written. Export the proposal for manual application.'
  const policyGerman = 'Das Ersetzen bestehender Quellen ist durch die Richtlinie gesperrt; es wurden keine Änderungen geschrieben. Exportiere den Änderungsvorschlag zur manuellen Anwendung.'
  const expected = new Map([
    [policyMessage, policyGerman],
    ['Request body too large.', 'Der Anfrageinhalt ist zu groß.'],
    ['Expected a JSON request body.', 'Ein JSON-Anfrageinhalt wird erwartet.'],
    ['Field created: Unsupported Zod constructor z.coerce().', 'Feld created: Nicht unterstützter Zod-Konstruktor z.coerce().'],
    ['Field title: Unsupported Zod method .transform().', 'Feld title: Nicht unterstützte Zod-Methode .transform().'],
    ['Frontmatter editing for date fields is not supported.', 'Das Bearbeiten von Frontmatter-Feldern vom Typ date wird nicht unterstützt.'],
    ['Frontmatter editing for array<string> fields is unsupported.', 'Das Bearbeiten von Frontmatter-Feldern vom Typ array<string> wird nicht unterstützt.'],
    ['Entry creation cannot set unsupported field created.', 'Das Anlegen des Eintrags kann das nicht unterstützte Feld created nicht setzen.'],
    ['Required field created is outside the supported scalar subset.', 'Das Pflichtfeld created liegt außerhalb der unterstützten skalaren Teilmenge.'],
    ['Value does not match supported schema field rank.', 'Der Wert entspricht nicht dem unterstützten Schemafeld rank.'],
    ['Value does not match supported field rank.', 'Der Wert entspricht nicht dem unterstützten Feld rank.'],
    ['Required field title is missing.', 'Das Pflichtfeld title fehlt.'],
    ['Field title must already exist exactly once.', 'Das Feld title muss bereits genau einmal existieren.'],
    ['Field title is not a supported scalar value.', 'Das Feld title ist kein unterstützter skalarer Wert.'],
    ['Content config exceeds the 64-collection discovery limit.', 'Die Inhaltssammlungs-Konfiguration überschreitet das Erkennungslimit von 64 Sammlungen.'],
    ['Collection exceeds the 250-entry discovery limit.', 'Die Sammlung überschreitet das Erkennungslimit von 250 Einträgen.'],
    ['Entry filename must be a simple lowercase slug ending in .md or .mdx.', 'Der Dateiname des Eintrags muss ein einfacher kleingeschriebener Slug mit der Endung .md oder .mdx sein.'],
    ['Content config changed during the write; reload and prepare the edit again.', 'Die Inhaltssammlungs-Konfiguration hat sich während des Schreibens geändert; lade neu und bereite die Bearbeitung erneut vor.'],
  ])
  for (const [reason, german] of expected) assert.equal(germanReason(reason), german)
  const collectionApiMessages = [
    'Collection editing is not configured.',
    'A previewId is required.',
    'Preview belongs to a different editor session.',
    'Invalid static collection creation operation.',
    'Invalid schema field extension operation.',
    'Preview expired.',
    'Commit differs from preview.',
    'Config no longer matches preview.',
    'Config changed immediately before write.',
    'Only a supported collection ID, new relative Markdown filename, scalar schema values, and config hash are accepted.',
    'Entry preview expired; prepare it again.',
    'Entry commit differs from preview.',
    'Entry no longer matches the confirmed preview.',
    'Collection changed immediately before entry creation.',
    'Only a collectionId, relative entryId, field, JSON scalar value, and content hash are accepted.',
    'A previewId and the unchanged collection edit operation are required.',
    'Preview expired; prepare the change again.',
    'Commit does not match the confirmed preview.',
    'The entry edit no longer matches the confirmed preview.',
  ]
  for (const message of collectionApiMessages) {
    const german = germanReason(message)
    assert.notEqual(german, message)
    assert.doesNotMatch(german, /^Nicht übersetzte Ursache:/)
  }
  assert.equal(withoutTerminalPunctuation(policyGerman), policyGerman.slice(0, -1))
  const blockedStatus = `Nicht gespeichert: ${withoutTerminalPunctuation(policyGerman)}. Lade den aktuellen Stand …`
  assert.equal(blockedStatus, 'Nicht gespeichert: Das Ersetzen bestehender Quellen ist durch die Richtlinie gesperrt; es wurden keine Änderungen geschrieben. Exportiere den Änderungsvorschlag zur manuellen Anwendung. Lade den aktuellen Stand …')
  assert.doesNotMatch(blockedStatus, /\.\.|Existing-source|Nicht übersetzte Ursache/)
  const configStatus = `Schreibstatus blockiert: ${withoutTerminalPunctuation(policyGerman)}; der Entwurf bleibt erhalten.`
  assert.equal(configStatus, 'Schreibstatus blockiert: Das Ersetzen bestehender Quellen ist durch die Richtlinie gesperrt; es wurden keine Änderungen geschrieben. Exportiere den Änderungsvorschlag zur manuellen Anwendung; der Entwurf bleibt erhalten.')
  assert.doesNotMatch(configStatus, /\.\.|Existing-source|Nicht übersetzte Ursache/)
  assert.equal(germanReason('A previously unknown failure detail.'), 'Nicht übersetzte Ursache: A previously unknown failure detail.')
})

test('the real file() loader and actual unsupported runtime fields surface translatable German reasons', async (t) => {
  const { germanReason } = await loadGermanReason()
  const realConfig = await readFile(new URL('../src/content.config.ts', import.meta.url), 'utf8')
  const discovered = discoverContentCollections(realConfig)
  const fileCollection = discovered.collections.find((collection) => collection.name === 'sampleSummary')
  assert.equal(fileCollection.supported, false)
  assert.match(fileCollection.reason, /glob\(\) loader/)
  assert.match(germanReason(fileCollection.reason), /glob\(\)-Loader/)

  const created = await mkdtemp(path.join(tmpdir(), 'avcms-german-reasons-'))
  const directory = await realpath(created)
  t.after(() => rm(created, { recursive: true, force: true }))
  const configPath = path.join(directory, 'src/content.config.mjs')
  const entryPath = path.join(directory, 'src/content/posts/one.md')
  await mkdir(path.dirname(entryPath), { recursive: true })
  await writeFile(configPath, `import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro:content'
export const collections = {
  posts: defineCollection({ loader: glob({ base: './src/content/posts', pattern: '**/*.md' }), schema: z.object({
    title: z.string(), created: z.date(), tags: z.array(z.string()),
  }) }),
}
`)
  await writeFile(entryPath, '---\ntitle: Example\ntags: [one]\n---\n')
  const runtime = createCollectionRuntime({ projectRoot: directory, contentConfigPath: 'src/content.config.mjs' })
  const state = publicCollectionState(runtime.inspect())
  const posts = state.collections.find((collection) => collection.id === 'posts')
  assert.equal(posts.mode, 'editable')
  const dateField = posts.fields.find((field) => field.name === 'created')
  const tagsField = posts.fields.find((field) => field.name === 'tags')
  assert.match(germanReason(dateField.reason), /Frontmatter-Feldern vom Typ date/)
  assert.match(germanReason(tagsField.reason), /Frontmatter-Feldern vom Typ array<string>/)
  assert.equal(germanReason(posts.creationReason), 'Das Anlegen von Einträgen erfordert, dass jedes Pflichtfeld die unterstützte skalare Teilmenge nutzt oder einen statischen Standardwert hat.')
  assert.throws(
    () => runtime.planEntryCreation({ collectionId: 'posts', entryId: 'UPPER.md', values: {}, hash: state.configHash }),
    (error) => germanReason(error.message) === 'Der Dateiname des Eintrags muss ein einfacher kleingeschriebener Slug mit der Endung .md oder .mdx sein.',
  )
})
