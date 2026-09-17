// install-a2a-relay-preset.mjs — installs the relay preset + bundle wiring into
// a DeepSeek Harness home. It mutates HOST-side files only:
//   1. copy the shipped `standard` preset  -> <home>/.agent-presets/a2a-relay/
//   2. rewrite the a2a-relay persona       -> "pure relay bridge" instructions
//   3. profiles/web/package.json           -> add the dsh-a2a-doorman dependency + bundle
//   4. profiles/web/cordis.patch.yml       -> server preset: standard -> a2a-relay
// It never edits the shipped preset install and never touches running processes.
//
// Run:  node tools/install-a2a-relay-preset.mjs
//
// Harness home resolution: $DSH_HOME (the harness home itself, e.g. ~/.dsh),
// falling back to ~/.dsh.
// Shipped-preset resolution: $DSH_PRESET_ROOT (directory containing the
// `standard` preset), else $DSH_APP_ROOT/config/agent-presets, else the usual
// global npm locations for @deepseek-ai/dsh.
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
if (!existsSync(join(home, 'profiles', 'web'))) {
  console.error(`install-a2a-relay-preset: cannot locate harness home (profiles/web) under ${home}`)
  console.error('Set DSH_HOME to the harness home directory (the one containing profiles/).')
  process.exit(4)
}

/** Candidate directories that may contain the shipped agent presets. */
function presetRootCandidates() {
  const candidates = []
  if (process.env.DSH_PRESET_ROOT) candidates.push(process.env.DSH_PRESET_ROOT)
  if (process.env.DSH_APP_ROOT) candidates.push(join(process.env.DSH_APP_ROOT, 'config', 'agent-presets'))
  // Global npm installs of @deepseek-ai/dsh, per platform.
  const globalRoots = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    join(homedir(), '.npm-global', 'lib', 'node_modules'),
  ].filter(Boolean)
  for (const root of globalRoots) {
    candidates.push(join(root, '@deepseek-ai', 'dsh', 'config', 'agent-presets'))
  }
  return candidates
}

function findShippedPresetRoot() {
  for (const candidate of presetRootCandidates()) {
    if (existsSync(join(candidate, 'standard', 'agent.cordis.yml'))) return candidate
  }
  return undefined
}

const presetRoot = findShippedPresetRoot()
if (!presetRoot) {
  console.error('install-a2a-relay-preset: cannot locate the shipped agent-presets root.')
  console.error('Set DSH_PRESET_ROOT to the directory that contains the `standard` preset.')
  process.exit(2)
}
const userPresetsDir = join(home, '.agent-presets')
const relayDir = join(userPresetsDir, 'a2a-relay')
const profileDir = join(home, 'profiles', 'web')

const summary = []
function record(msg) {
  summary.push(msg)
  console.log(msg)
}

// ---------- 1. copy standard -> a2a-relay ----------
if (existsSync(join(relayDir, 'agent.cordis.yml'))) {
  record(`relay preset already exists: ${relayDir} (leaving copy untouched)`)
} else {
  mkdirSync(relayDir, { recursive: true })
  for (const name of ['agent.cordis.yml', 'preset.yml']) {
    const src = join(presetRoot, 'standard', name)
    const dst = join(relayDir, name)
    if (!existsSync(src)) continue
    cpSync(src, dst)
    record(`copied ${src} -> ${dst}`)
  }
}

// ---------- 2. rewrite persona to pure-relay ----------
const relayCompositionPath = join(relayDir, 'agent.cordis.yml')
if (existsSync(relayCompositionPath)) {
  let text = readFileSync(relayCompositionPath, 'utf8')
  const persona = `You are the A2A↔DSH relay bridge: a stateless forwarding agent connecting a remote A2A caller to a watched DeepSeek Harness session.

You receive ONE inbound user message per A2A task. Handle it strictly as follows:
1. Call the doorman_relay tool with text set to the EXACT full inbound message text — nothing added, nothing removed, no quoting or commentary.
2. The tool injects that text as a fresh user turn into the watched target session, waits for that session to finish answering, and returns the target session's text reply.
3. Reply to the caller with EXACTLY the tool's returned text as your only message. Do not add greetings, explanation, reasoning, or markdown framing; do not paraphrase or shorten.

Hard rules: never answer the inbound message yourself; never use file, shell, search, planning, or any other tool to investigate or answer — the target session is the only authority. If doorman_relay reports an error, reply with the error text verbatim.`
  const old = text.match(/text: >-\n( {6,})You are a coding agent powered by the \{\{model\}\} model\. Your working directory is \{\{cwd\}\}\./)
  if (old) {
    const indent = old[1]
    const block = persona.split('\n').map((l) => indent + l).join('\n')
    const replaced = text.slice(0, old.index) + 'text: >-\n' + block + text.slice(old.index + old[0].length)
    writeFileSync(relayCompositionPath, replaced)
    record(`rewrote persona in ${relayCompositionPath}`)
  } else {
    // Fall back: replace the whole persona block by id marker.
    const marker = text.indexOf('- id: persona\n')
    const nextRow = text.indexOf('\n- id: ', marker + 12)
    if (marker >= 0 && nextRow > marker) {
      const indent = '      '
      const block = persona.split('\n').map((l) => indent + l).join('\n')
      const personaRow = `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: >-\n${block}\n`
      const replaced = text.slice(0, marker) + personaRow + text.slice(nextRow + 1)
      writeFileSync(relayCompositionPath, replaced)
      record(`rewrote persona block (fallback) in ${relayCompositionPath}`)
    } else {
      record(`WARN: could not locate persona row in ${relayCompositionPath}`)
    }
  }
}

// ---------- 3. profiles/web/package.json ----------
const manifestPath = join(profileDir, 'package.json')
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundleDir = join(repoRoot, 'bundle', 'dsh-a2a-doorman')
  const fileRef = `file:${bundleDir.replace(/\\/g, '/')}`
  manifest.dependencies = manifest.dependencies ?? {}
  if (!manifest.dependencies['dsh-a2a-doorman']) {
    manifest.dependencies['dsh-a2a-doorman'] = fileRef
    record(`package.json dependencies += dsh-a2a-doorman -> ${fileRef}`)
  } else {
    record(`package.json already depends on dsh-a2a-doorman (${manifest.dependencies['dsh-a2a-doorman']})`)
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    console.error('install-a2a-relay-preset: manifest has no dsh.profile.bundles array; aborting manifest edit')
    process.exit(3)
  }
  if (!bundles.includes('dsh-a2a-doorman')) {
    manifest.dsh.profile.bundles = [...bundles, 'dsh-a2a-doorman']
    record(`dsh.profile.bundles += dsh-a2a-doorman -> ${JSON.stringify(manifest.dsh.profile.bundles)}`)
  } else {
    record('dsh.profile.bundles already includes dsh-a2a-doorman')
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

// ---------- 4. profiles/web/cordis.patch.yml: server preset -> a2a-relay ----------
const patchPath = join(profileDir, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  let text = readFileSync(patchPath, 'utf8')
  const before = (text.match(/preset:\s*(standard|a2a-relay)/g) ?? []).join(', ')
  const updated = text.replace(/(preset:\s*)standard/g, '$1a2a-relay')
  if (updated !== text) {
    writeFileSync(patchPath, updated)
    record(`cordis.patch.yml: preset ${before || '(none found)'} -> a2a-relay`)
  } else {
    record(`cordis.patch.yml: no 'preset: standard' to change (current: ${before || '(none)'})`)
  }
}

console.log('--- summary ---')
for (const line of summary) console.log(line)
console.log(`repoRoot=${repoRoot}\nprofileDir=${profileDir}\nrelayDir=${relayDir}`)
