// Decode a dsh session .jsonl.zstd artifact (concatenated zstd frames) to plain JSONL.
// Usage: node tools/decode-zstd.mjs <input.zstd> [output.jsonl]
// Frame scanner transcribed from the harness's own dsh-session-persistence-jsonl
// (lib/index.js scanZstdFrames) — authoritative for these artifacts.
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216 // 0xfd2fb528 little-endian read

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt zstd log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt zstd log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const input = process.argv[2]
const out = process.argv[3] ?? input.replace(/\.zstd$/, '') + '.decoded.jsonl'
const buf = readFileSync(input)

const { frames, tornStart } = scanZstdFrames(buf)
const parts = []
for (const f of frames) {
  parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'))
}
const text = parts.join('')
const lines = text.split('\n').filter((l) => l.trim().length > 0)
writeFileSync(out, text)
console.log(`frames: ${frames.length} (tornStart=${tornStart ?? 'none'}); decoded lines: ${lines.length}`)
console.log(`wrote: ${out}`)
console.log('event types:', [...new Set(lines.map((l) => { try { return JSON.parse(l).type } catch { return '?' } }))].join(', '))
