#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects')

// ===== CLI args =====

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const selectAll = args.includes('--all')
const exportIdx = args.indexOf('--export')
const exportPath = exportIdx !== -1 ? args[exportIdx + 1] : null

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  memory-sync — Sync Claude Code memories

  Usage:
    memory-sync              Interactive select → format → clipboard
    memory-sync --list       List all memories
    memory-sync --all        Select all → format → clipboard
    memory-sync --export <f> Export to file
  `)
  process.exit(0)
}

// ===== Prompt =====

const PROMPT = `You are a memory consolidation assistant. I'll give you a set of Claude Code memories from various projects.

Your task: merge and deduplicate them into a single, clean memory document that can be imported as a Claude.ai project prompt.

## Rules:
1. Preserve the user's original words verbatim where possible
2. Deduplicate — if the same fact appears in multiple memories, keep the most detailed version
3. Group into these sections (skip empty ones):
   - **Instructions**: Rules the user asked Claude to follow (tone, format, "always do X", "never do Y")
   - **Identity**: Name, location, education, languages, personal details
   - **Career**: Roles, companies, skills
   - **Projects**: One entry per project — what it does, status, key decisions
   - **Preferences**: Opinions, tastes, working style
4. Within each section, one entry per line, sorted oldest first
5. Format: \`[YYYY-MM-DD] - content\` (use \`[unknown]\` if no date)
6. Wrap entire output in a code block

---

Here are the memories to process:

`

// ===== Helpers =====

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/)
  if (!m) return { meta: {}, body: content }
  const meta = {}
  m[1].split('\n').forEach(line => {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  })
  return { meta, body: m[2].trim() }
}

function projectName(dirName) {
  const decoded = dirName.replace(/^-/, '').replace(/-/g, '/')
  const home = process.env.HOME.replace(/\//g, '/')
  const rel = decoded.startsWith(home.slice(1))
    ? '~/' + decoded.slice(home.length)
    : decoded
  return rel.split('/').slice(-2).join('/')
}

function scanMemories() {
  if (!fs.existsSync(PROJECTS_DIR)) return []
  const memories = []
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, proj, 'memory')
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md' || f.startsWith('.')) continue
      const content = fs.readFileSync(path.join(dir, f), 'utf8')
      const { meta, body } = parseFrontmatter(content)
      if (!body) continue
      memories.push({
        project: projectName(proj),
        file: f,
        name: meta.name || f.replace('.md', ''),
        type: meta.type || 'unknown',
        description: meta.description || '',
        body
      })
    }
  }
  return memories
}

// ===== Interactive Selector =====

let lastRenderedLines = 0

function visLineCount(str, cols) {
  // ANSI escape codes don't occupy visual width
  const clean = str.replace(/\x1B\[[0-9;]*m/g, '')
  return Math.max(1, Math.ceil(clean.length / cols))
}

function render(memories, cursor, selected, expandedIdx, first) {
  const cols = process.stdout.columns || 80

  if (!first) {
    process.stdout.write(`\x1B[${lastRenderedLines}A\x1B[J`)
  }

  let lines = 0
  const w = s => { process.stdout.write(s + '\n'); lines += visLineCount(s, cols) }

  w(`  \x1B[2m↑↓ move  Space select  e expand  a all  Enter confirm (${selected.size} selected)\x1B[0m`)

  let lastProj = ''
  const bodyMax = cols - 8
  memories.forEach((m, i) => {
    if (m.project !== lastProj) {
      lastProj = m.project
      w(`  \x1B[36m${lastProj}\x1B[0m`)
    }
    const ptr = i === cursor ? '\x1B[33m❯\x1B[0m' : ' '
    const chk = selected.has(i) ? '\x1B[32m✔\x1B[0m' : '\x1B[2m○\x1B[0m'
    const tag = m.type.padEnd(10)
    const hi = i === cursor ? `\x1B[1m${m.name}\x1B[0m` : m.name
    const arrow = i === expandedIdx ? ' ▼' : ''
    w(`  ${ptr} ${chk}  \x1B[2m${tag}\x1B[0m  ${hi}${arrow}`)
    if (i === expandedIdx) {
      for (const line of m.body.split('\n')) {
        const t = line.length > bodyMax ? line.slice(0, bodyMax - 1) + '…' : line
        w(`       \x1B[2m${t}\x1B[0m`)
      }
    }
  })

  lastRenderedLines = lines
}

function interactiveSelect(memories) {
  return new Promise(resolve => {
    const selected = new Set()
    let expandedIdx = -1
    let cursor = 0

    render(memories, cursor, selected, expandedIdx, true)

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')

    const onData = key => {
      if (key === '\u0003' || key === 'q') {
        process.stdout.write('\n')
        process.stdin.setRawMode(false)
        process.exit(0)
      }
      if (key === '\r') {
        process.stdout.write('\n')
        process.stdin.removeListener('data', onData)
        process.stdin.setRawMode(false)
        process.stdin.pause()
        resolve([...selected].sort().map(i => memories[i]))
        return
      }
      if (key === 'e') {
        expandedIdx = expandedIdx === cursor ? -1 : cursor
      }
      if (key === ' ') {
        selected.has(cursor) ? selected.delete(cursor) : selected.add(cursor)
        cursor = Math.min(cursor + 1, memories.length - 1)
        if (expandedIdx >= 0) expandedIdx = cursor
      }
      if (key === 'a') {
        selected.size === memories.length ? selected.clear() : memories.forEach((_, i) => selected.add(i))
      }
      if (key === '\x1B[A' || key === 'k') {
        cursor = Math.max(0, cursor - 1)
        if (expandedIdx >= 0) expandedIdx = cursor
      }
      if (key === '\x1B[B' || key === 'j') {
        cursor = Math.min(memories.length - 1, cursor + 1)
        if (expandedIdx >= 0) expandedIdx = cursor
      }

      render(memories, cursor, selected, expandedIdx, false)
    }

    process.stdin.on('data', onData)
  })
}

// ===== Main =====

async function main() {
  const memories = scanMemories()

  if (memories.length === 0) {
    console.log('No memories found.')
    process.exit(0)
  }

  console.log(`Found ${memories.length} memories:\n`)

  if (listOnly) {
    let lastProj = ''
    memories.forEach((m, i) => {
      if (m.project !== lastProj) { lastProj = m.project; console.log(`  \x1B[36m${lastProj}\x1B[0m`) }
      console.log(`  ${String(i + 1).padStart(3)}. [${m.type}]  ${m.name}`)
    })
    return
  }

  let selected
  if (selectAll) {
    selected = memories
    console.log(`Selected all ${memories.length} memories.`)
  } else {
    selected = await interactiveSelect(memories)
    if (selected.length === 0) {
      console.log('Nothing selected.')
      return
    }
  }

  console.log(`Formatting ${selected.length} memories...\n`)

  const body = selected.map((m, i) =>
    `### Memory ${i + 1}: ${m.name} (${m.type}, project: ${m.project})\n\n${m.body}`
  ).join('\n\n---\n\n')

  try {
    const result = execSync('claude -p --no-session-persistence', {
      input: PROMPT + body,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000
    })

    console.log(result)

    if (exportPath) {
      const resolved = path.resolve(exportPath)
      fs.writeFileSync(resolved, result)
      console.log(`\nExported to ${resolved}`)
    } else {
      try {
        execSync('pbcopy', { input: result })
        console.log('\n✓ Copied to clipboard.')
      } catch {
        // non-macOS, skip
      }
    }
  } catch (err) {
    console.error('Claude error:', err.message)
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
