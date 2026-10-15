// Joins the hooks modules into hooks/bundle.tsx, the one module hooks.json loads.
//
// Why: Claude Code before 2.1.299 refuses a hooks module that passes $ into a
// function imported from another file, and the plugin then fails to load with
// no message. In one file nothing crosses an import, so every version loads it.
// The modules in hooks/ stay the source; bundle.tsx is generated from them.
//
//   node tools/bundle.mjs           writes hooks/bundle.tsx
//   node tools/bundle.mjs --check   fails if hooks/bundle.tsx is out of date (CI)
//   node --test tools/              runs the build step's own tests
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// --hooks <dir> builds from another folder (the tests use small ones).
const at = process.argv.indexOf('--hooks')
const HOOKS = at > 0 ? process.argv[at + 1] : join(import.meta.dirname, '..', 'hooks')
const OUT = join(HOOKS, 'bundle.tsx')
const ENTRY = 'register.tsx'

const files = readdirSync(HOOKS).filter(f => /\.tsx?$/.test(f) && f !== 'bundle.tsx')
const fileOf = spec => files.find(f => f.replace(/\.tsx?$/, '') === spec.replace(/^\.\//, ''))

// Each module's imports: './x' ones become plain references in the joined
// file; 'claude-code' and '../types' ones are gathered and written once.
const IMPORT = /^import (type )?\{([^}]*)\} from '([^']+)'\n/gm
const modules = new Map()
const stop = (f, line, why) => { throw new Error(`hooks/${f}:${line}: ${why}`) }
for (const f of files) {
  const text = readFileSync(join(HOOKS, f), 'utf8')
  // Only one-line `import { a, b } from '...'` is understood. Anything else
  // would leave a broken file, so it stops here with the line to change.
  text.split('\n').forEach((line, i) => {
    if (/^\s*import\b/.test(line) && !/^import (type )?\{[^}]*\} from '[^']+'$/.test(line)) stop(f, i + 1, 'write imports on one line as import { a, b } from \'...\'')
    if (/^\s*export\s*(\*|\{[^}]*\})\s*from\b/.test(line)) stop(f, i + 1, 're-exports are not joined; import the name where it is used')
    if (/^import .*\bas\b.* from '\.\//.test(line)) stop(f, i + 1, 'an import renamed with "as" is not joined; use the original name')
  })
  const deps = []
  const outside = []
  for (const [, isType, names, from] of text.matchAll(IMPORT)) {
    if (from.startsWith('./')) deps.push(fileOf(from))
    else outside.push({ isType: !!isType, names: names.split(',').map(n => n.trim()).filter(Boolean), from })
  }
  modules.set(f, { text: text.replace(IMPORT, ''), deps: deps.filter(Boolean), outside })
}

// Dependencies first, the entry module last. A cycle is fine for functions
// (declarations are hoisted), so a module already on the path is skipped.
const order = []
const visit = (f, path = new Set()) => {
  if (order.includes(f) || path.has(f)) return
  path.add(f)
  for (const d of modules.get(f).deps) visit(d, path)
  order.push(f)
}
for (const f of files.filter(f => f !== ENTRY).sort()) visit(f)
visit(ENTRY)

// One import line per outside source: values and types kept apart.
const gathered = new Map()
for (const f of order) {
  for (const { isType, names, from } of modules.get(f).outside) {
    const key = `${isType ? 'type ' : ''}${from}`
    const set = gathered.get(key) ?? new Set()
    for (const n of names) set.add(n)
    gathered.set(key, set)
  }
}
const imports = [...gathered].map(([key, names]) => {
  const isType = key.startsWith('type ')
  const from = isType ? key.slice(5) : key
  return `import ${isType ? 'type ' : ''}{ ${[...names].sort().join(', ')} } from '${from}'`
})

// Every other top-level name must be unique across the modules: joined, two
// of the same name clash. Say which modules, not where the bundle broke.
const owner = new Map()
for (const f of order) {
  for (const [, name] of modules.get(f).text.matchAll(/^(?:export )?(?:async )?(?:function|let|class|type|interface) (\w+)/gm)) {
    if (owner.has(name)) throw new Error(`"${name}" is declared in both hooks/${owner.get(name)} and hooks/${f}; rename one`)
    owner.set(name, f)
  }
}

// A top-level const several modules declare alike (the shared atom, a pane
// id) is kept once; one declared differently is an error, not a guess.
const seen = new Map()
const body = order.map(f => {
  const lines = modules.get(f).text.split('\n').filter(line => {
    const m = /^(?:export )?const (\w+) = (.*)$/.exec(line)
    if (!m) return true
    const [, name, value] = m
    if (!seen.has(name)) return seen.set(name, { value, f }), true
    if (seen.get(name).value === value) return false
    throw new Error(`${name} is declared differently in ${seen.get(name).f} and ${f}`)
  })
  return `// ── ${f} ${'─'.repeat(Math.max(4, 70 - f.length))}\n${lines.join('\n').trim()}\n`
})

// The source with every string, comment and template's text blanked out,
// keeping the code inside a template's ${...}.
function codeOnly(src) {
  let out = ''
  let i = 0
  const inner = []
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue }
    if (c === "'" || c === '"') { i++; while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1; i++; out += '""'; continue }
    if (c === '`' || (c === '}' && inner.at(-1) === 0)) {
      if (c === '}') inner.pop()
      i++
      while (i < src.length && src[i] !== '`' && !(src[i] === '$' && src[i + 1] === '{')) i += src[i] === '\\' ? 2 : 1
      if (src[i] === '$') { inner.push(0); i += 2; out += ' ' } else { i++; out += '""' }
      continue
    }
    if (c === '{' && inner.length) inner[inner.length - 1]++
    if (c === '}' && inner.length) inner[inner.length - 1]--
    out += c
    i++
  }
  return out
}

// Claude Code compiles every element in a .tsx file to a call of h (and a
// fragment to Fragment), so the joined file must not use either as a name of
// its own. Strings and comments aside, h may only appear where it's called.
const code = codeOnly(body.join('\n'))
// An object key (`{ h: 1 }`) is not a name, so it is allowed.
for (const m of code.matchAll(/(?<![\w.$])(h|Fragment)(?![\w$])/g)) {
  const isKey = /[{,]\s*$/.test(code.slice(0, m.index)) && /^\s*:/.test(code.slice(m.index + m[0].length))
  if (!isKey) throw new Error(`"${m[1]}" is used as a name in the hooks; Claude Code reserves it in .tsx files. Rename it.`)
}

const out = [
  '// Generated by tools/bundle.mjs from the modules in hooks/. Edit those, then',
  '// run `node tools/bundle.mjs`; this file is what hooks.json loads.',
  '',
  ...imports,
  '',
  body.join('\n'),
].join('\n')

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8')
  if (current !== out) {
    console.error('hooks/bundle.tsx is out of date: run node tools/bundle.mjs')
    process.exit(1)
  }
  console.log('hooks/bundle.tsx is up to date')
} else {
  writeFileSync(OUT, out)
  console.log(`hooks/bundle.tsx: ${order.join(', ')}`)
}
