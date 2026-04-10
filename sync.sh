#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const readline = require('readline')

const PROJECTS_DIR = path.join(process.env.HOME, '.claude', 'projects')

// ===== CLI 参数解析 =====

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const selectAll = args.includes('--all')
const exportIdx = args.indexOf('--export')
const exportPath = exportIdx !== -1 ? args[exportIdx + 1] : null

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  memory-sync — Sync Claude Code memories to Claude.ai

  Usage:
    memory-sync              Interactive select → Claude format → clipboard
    memory-sync --list       List all memories
    memory-sync --all        Select all → Claude format → clipboard
    memory-sync --export <path>  Export formatted output to file
  `)
  process.exit(0)
}

// ===== 格式化 Prompt =====

const PROMPT_TEMPLATE = `Export all of my stored memories and any context you've learned about me from past conversations. Preserve my words verbatim where possible, especially for instructions and preferences.

## Categories (output in this order):

1. **Instructions**: Rules I've explicitly asked you to follow going forward — tone, format, style, "always do X", "never do Y", and corrections to your behavior. Only include rules from stored memories, not from conversations.

2. **Identity**: Name, age, location, education, family, relationships, languages, and personal interests.

3. **Career**: Current and past roles, companies, and general skill areas.

4. **Projects**: Projects I meaningfully built or committed to. Ideally ONE entry per project. Include what it does, current status, and any key decisions. Use the project name or a short descriptor as the first words of the entry.

5. **Preferences**: Opinions, tastes, and working-style preferences that apply broadly.

## Format:

Use section headers for each category. Within each category, list one entry per line, sorted by oldest date first. Format each line as:

[YYYY-MM-DD] - Entry content here.

If no date is known, use [unknown] instead.

## Output:
- Wrap the entire export in a single code block for easy copying.
- After the code block, state whether this is the complete set or if more remain.

---

Here are the stored memories to process:

`

// ===== 工具函数 =====

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/)
  if (!match) return { meta: {}, body: content }
  const meta = {}
  match[1].split('\n').forEach(line => {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      meta[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
    }
  })
  return { meta, body: match[2].trim() }
}

function prettyProjectName(dirName) {
  const decoded = dirName.replace(/^-/, '').replace(/-/g, '/')
  const home = process.env.HOME.replace(/\//g, '/')
  const relative = decoded.startsWith(home.slice(1))
    ? '~/' + decoded.slice(home.length)
    : decoded
  const parts = relative.split('/')
  return parts.slice(-2).join('/')
}

function scanMemories() {
  if (!fs.existsSync(PROJECTS_DIR)) {
    return []
  }
  const projects = fs.readdirSync(PROJECTS_DIR)
  const memories = []

  for (const project of projects) {
    const memoryDir = path.join(PROJECTS_DIR, project, 'memory')
    if (!fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory()) continue

    const files = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && !f.startsWith('.'))

    for (const file of files) {
      const content = fs.readFileSync(path.join(memoryDir, file), 'utf8')
      const { meta, body } = parseFrontmatter(content)
      if (!body) continue
      memories.push({
        project: prettyProjectName(project),
        file,
        name: meta.name || file.replace('.md', ''),
        type: meta.type || 'unknown',
        description: meta.description || '',
        body
      })
    }
  }
  return memories
}

function displayMemories(memories) {
  let currentProject = ''
  memories.forEach((m, i) => {
    if (m.project !== currentProject) {
      currentProject = m.project
      console.log(`\n  [${currentProject}]`)
    }
    const tag = `[${m.type}]`
    console.log(`  ${String(i + 1).padStart(3)}. ${tag.padEnd(12)} ${m.name}`)
    if (m.description) {
      console.log(`       ${m.description.slice(0, 80)}`)
    }
  })
  console.log()
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ===== 主流程 =====

async function main() {
  const memories = scanMemories()

  if (memories.length === 0) {
    console.log('No memories found.')
    process.exit(0)
  }

  console.log(`Found ${memories.length} memories:`)
  displayMemories(memories)

  if (listOnly) return

  // 选择
  let selected
  if (selectAll) {
    selected = memories
  } else {
    const answer = await ask('Select (space-separated numbers, "all", or "q" to quit): ')
    if (answer.toLowerCase() === 'q') return
    if (answer.toLowerCase() === 'all') {
      selected = memories
    } else {
      const indices = answer.split(/[\s,]+/).map(Number).filter(n => n > 0 && n <= memories.length)
      if (indices.length === 0) {
        console.log('No valid selection.')
        return
      }
      selected = indices.map(i => memories[i - 1])
    }
  }

  console.log(`\nFormatting ${selected.length} memories with Claude...\n`)

  // 拼接 prompt
  const memoryContent = selected.map((m, i) =>
    `### Memory ${i + 1}: ${m.name} (${m.type}, project: ${m.project})\n\n${m.body}`
  ).join('\n\n---\n\n')

  const fullPrompt = PROMPT_TEMPLATE + memoryContent

  // 调用 claude
  try {
    const result = execSync('claude -p --bare --no-session-persistence', {
      input: fullPrompt,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000
    })

    // 输出结果
    console.log(result)

    if (exportPath) {
      const resolved = path.resolve(exportPath)
      fs.writeFileSync(resolved, result)
      console.log(`\nExported to ${resolved}`)
    } else {
      execSync('pbcopy', { input: result })
      console.log('\nCopied to clipboard. Paste into Claude.ai.')
    }
  } catch (err) {
    if (err.status) {
      console.error(`Claude exited with code ${err.status}`)
      if (err.stderr) console.error(err.stderr)
    } else {
      console.error('Error:', err.message)
    }
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})


