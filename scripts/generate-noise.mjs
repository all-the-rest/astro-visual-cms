import { randomBytes } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const OUTPUT_DIR = path.join(ROOT, 'public/images')
const WIDTH = 640
const HEIGHT = 400

await mkdir(OUTPUT_DIR, { recursive: true })

for (let index = 1; index <= 3; index += 1) {
  const pixels = randomBytes(WIDTH * HEIGHT * 3)
  const output = path.join(OUTPUT_DIR, `noise-fixture-0${index}.jpg`)
  try {
    await access(output)
    console.log(`Kept existing ${path.relative(ROOT, output)}`)
    continue
  } catch {
    // The random fixture is created on first use and preserved across builds.
  }
  await sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .jpeg({ quality: 82, chromaSubsampling: '4:4:4' })
    .toFile(output)
  console.log(`Generated ${path.relative(ROOT, output)} (${pixels.length} random RGB bytes)`)
}
