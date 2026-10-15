// Tests for tools/bundle.mjs: each builds a small hooks folder and checks that
// the joined file comes out right, or that the step stops with a clear reason.
// Run with: node --test tools/
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = join(import.meta.dirname, 'bundle.mjs')
const REPO_HOOKS = join(import.meta.dirname, '..', 'hooks')

// A hooks folder from { 'name.ts': 'source' }; the entry is register.tsx.
function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'))
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}
const build = (dir, ...args) => spawnSync('node', [SCRIPT, '--hooks', dir, ...args], { encoding: 'utf8' })
const built = dir => readFileSync(join(dir, 'bundle.tsx'), 'utf8')
const ENTRY = "import type { Register } from 'claude-code'\nexport const register: Register = on => {}\n"

test('the real hooks build, and building twice gives the same file', () => {
  const first = execFileSync('node', [SCRIPT, '--check'], { encoding: 'utf8' })
  assert.match(first, /up to date/)
  const before = readFileSync(join(REPO_HOOKS, 'bundle.tsx'), 'utf8')
  execFileSync('node', [SCRIPT])
  assert.equal(readFileSync(join(REPO_HOOKS, 'bundle.tsx'), 'utf8'), before)
})

test('a module comes before the modules that use it', () => {
  const dir = folder({
    'register.tsx': `import { b } from './b'\n${ENTRY}`,
    'b.ts': "import { a } from './a'\nexport const b = a + 1\n",
    'a.ts': 'export const a = 1\n',
  })
  assert.equal(build(dir).status, 0)
  const out = built(dir)
  assert.ok(out.indexOf('// ── a.ts') < out.indexOf('// ── b.ts'))
  assert.ok(out.indexOf('// ── b.ts') < out.indexOf('// ── register.tsx'))
  assert.ok(!out.includes("from './"), 'no import between modules is left')
})

test('imports from outside are gathered once, values and types apart', () => {
  const dir = folder({
    'register.tsx': `import { atom } from 'claude-code'\nimport type { Register } from 'claude-code'\nimport { x } from './x'\nexport const register: Register = on => {}\n`,
    'x.ts': "import { atom, read } from 'claude-code'\nimport type { EngineInterface } from 'claude-code'\nexport const x = 1\n",
  })
  assert.equal(build(dir).status, 0)
  const out = built(dir)
  assert.match(out, /^import \{ atom, read \} from 'claude-code'$/m)
  assert.match(out, /^import type \{ EngineInterface, Register \} from 'claude-code'$/m)
  assert.equal(out.match(/^import /gm).length, 2)
})

test('a const two modules declare alike is kept once; declared differently, it stops', () => {
  const same = folder({ 'register.tsx': `import { a } from './a'\nconst ID = 'x'\n${ENTRY}`, 'a.ts': "export const ID = 'x'\nexport const a = 1\n" })
  assert.equal(build(same).status, 0)
  assert.equal(built(same).match(/const ID = /g).length, 1)
  const differ = folder({ 'register.tsx': `import { a } from './a'\nconst ID = 'y'\n${ENTRY}`, 'a.ts': "export const ID = 'x'\nexport const a = 1\n" })
  const r = build(differ)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /ID is declared differently/)
})

test('two modules with a function of the same name stop with both names', () => {
  const dir = folder({
    'register.tsx': `import { a } from './a'\nfunction helper() {}\n${ENTRY}`,
    'a.ts': 'function helper() {}\nexport const a = 1\n',
  })
  const r = build(dir)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /"helper" is declared in both hooks\/a\.ts and hooks\/register\.tsx/)
})

test('imports the step cannot join stop with the file and line', () => {
  const cases = [
    ["import {\n  a,\n} from './a'\n", /register\.tsx:1: write imports on one line/],
    ["import { a as b } from './a'\n", /renamed with "as"/],
    ["import * as all from './a'\n", /register\.tsx:1: write imports on one line/],
    ["import './a'\n", /register\.tsx:1: write imports on one line/],
    ["export { a } from './a'\n", /re-exports are not joined/],
  ]
  for (const [head, reason] of cases) {
    const r = build(folder({ 'register.tsx': `${head}${ENTRY}`, 'a.ts': 'export const a = 1\n' }))
    assert.notEqual(r.status, 0, head)
    assert.match(r.stderr, reason, head)
  }
})

test('h and Fragment as names stop the build; in strings or as properties they are fine', () => {
  const stops = ['let h = 0', 'function f(h: number) { return h }', 'const x = `${h}`', 'const y = `${f(`${h}`)}`', 'const Fragment = 1', 'const [w, h] = [1, 2]']
  for (const line of stops) {
    const r = build(folder({ 'register.tsx': `${line}\n${ENTRY}` }))
    assert.notEqual(r.status, 0, line)
    assert.match(r.stderr, /reserves it in \.tsx files/, line)
  }
  const fine = ["const a = 'h'", 'const b = "Fragment"', 'const c = { h: 1 }.h', 'const height = 2', '// h is fine in a comment', '/* h */ const e = 1', 'const d = `h`', 'const f = `a ${x} h ${y}`']
  for (const line of fine) assert.equal(build(folder({ 'register.tsx': `${line}\n${ENTRY}` })).status, 0, line)
})

test('--check fails when a module changed and the bundle was not rebuilt', () => {
  const dir = folder({ 'register.tsx': `import { a } from './a'\n${ENTRY}`, 'a.ts': 'export const a = 1\n' })
  assert.equal(build(dir).status, 0)
  assert.equal(build(dir, '--check').status, 0)
  writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n')
  const r = build(dir, '--check')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /out of date/)
})

test('the bundle itself is never read back in as a module', () => {
  const dir = folder({ 'register.tsx': ENTRY })
  assert.equal(build(dir).status, 0)
  assert.equal(build(dir).status, 0)
  assert.equal(built(dir).match(/\/\/ ── register\.tsx/g).length, 1)
})

test('$, on and next stay Claude Code\'s: no type arguments, no names of our own', () => {
  const stops = [
    'async function readMeta($: unknown) { return 1 }\nconst m = readMeta<number>($, 1)',
    'const on = 1',
    'function split(site: string, on: boolean) { return on }',
    'let next = 0',
    'const pick = (next: number) => next',
  ]
  for (const line of stops) {
    const r = build(folder({ 'register.tsx': `${line}\n${ENTRY}` }))
    assert.notEqual(r.status, 0, line)
    assert.match(r.stderr, /Claude Code's|type argument/, line)
  }
  const fine = [
    "import type { Register } from 'claude-code'\nexport const register: Register = on => {\n  on('session.start', async ($, e, next) => next(e))\n}",
    'const lane = { next: 1, on: 2 }\nlane.next = 3',
    "const label = 'on'",
    'const isOn = true',
  ]
  for (const src of fine) {
    const body = src.includes('register') ? `${src}\n` : `${src}\n${ENTRY}`
    const r = build(folder({ 'register.tsx': body }))
    assert.equal(r.status, 0, `${src}\n${r.stderr}`)
  }
})
