#!/usr/bin/env node
/* 在庫 (inventory) の作り方を、方式 × ホスト × セッションの大きさで比べる計測スクリプト。Issue #2。

   node tools/measure-inventory.mjs run     --plan plan.json --out DIR [--only id,id] [--dry]
   node tools/measure-inventory.mjs report  --out DIR            結果の表 (results.md を書く)
   node tools/measure-inventory.mjs review  --out DIR            セッションごとの在庫の並べ読みを review-<key>.md に書く
   node tools/measure-inventory.mjs extract --host claude|codex --jsonl PATH   P 方式で渡す本文を出力する
   node tools/measure-inventory.mjs stat    --host claude|codex --jsonl PATH   セッションの大きさ
   node tools/measure-inventory.mjs selftest

   方式 (method)
     F   呼び出し元のセッションを fork して、在庫を JSON で出させる (server.mjs と同じ引数)
     S   別のモデルに jsonl のパスを渡し、読み取り専用ツールで読ませてまとめさせる
     P   jsonl からユーザーとアシスタントの発話だけを抜き出し、プロンプトに入れて渡す (ツールなし)
     B   床の測定。会話なしの 1 往復 (CLI の起動 + 最小の生成)
     BF  床の測定。fork して「OK」とだけ返させる (fork の読み込みだけの時間)
     SL PL BL  S / P / B を軽い起動で (claude は --strict-mcp-config、codex は --ignore-user-config --ignore-rules)

   plan.json
     { "timeoutSec": 900,
       "sessions": { "<key>": { "host": "claude|codex", "id": "...", "cwd": "...", "jsonl": "...", "label": "long" } },
       "cells": [ { "session": "<key>", "method": "F", "run": 1 }, { "host": "claude", "method": "B", "run": 1 } ] }
   セルの id は <key または host>-<method>-<run>。出力は DIR/runs/<id>-aN/ に残し、各実行を DIR/results.jsonl に1行足す。 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadavg, tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
// 在庫の領域知識 (プロンプト・形の検証・発話の抜き出し・記録の場所) は、サーバーと共有する1か所に置く
import { CAPS, SPEC, prefilteredPrompt, validateInventory, modelJson, parseLines, extract, extractClaude, extractCodex, locateTranscript } from '../.agents/skills/intra-turn-board/inventory.mjs'

const SUMMARIZER_MODEL = { claude: 'sonnet', codex: 'gpt-6.2-sol' }

/* ============ プロンプト ============
   P 方式のプロンプト (prefilteredPrompt) と、SPEC は共有の inventory.mjs にある。F / S / B はこの計測だけで使う */
const FORMAT_HINTS = {
  claude: `- 1行が1つの JSON。発話は "type":"user" と "type":"assistant" の行にあり、message.content が文字列か {"type":"text"} ブロックの配列
- tool_use、tool_result、thinking のブロックと、type が user / assistant 以外の行は作業の記録。論点や決定の根拠になるときだけ見る
- "isCompactSummary":true の行があるときは、それより前の発話はその要約に置き換わっている`,
  codex: `- 1行が1つの JSON。発話は "type":"response_item" で payload.type が "message" の行にあり、payload.role が user / assistant、本文は content[].text
- role が developer の行と、先頭の "# AGENTS.md instructions" や "<environment_context>" で始まる user の行は、システムが入れた文脈なので会話として扱わない
- function_call、custom_tool_call、reasoning などは作業の記録。論点や決定の根拠になるときだけ見る`,
}

const forkPrompt = () => `あなたは、これまでの会話の文脈 (あなたが引き継いだ会話) から「在庫」を作る係です。ツールは使わず、ファイルも読まない。\n\n${SPEC}`
const summarizerPrompt = (host, path) => `あなたは、AI エージェントとユーザーの会話の記録から「在庫」を作る係です。\n\n## 会話の記録\nファイル: ${path}\n読み取り専用のツールで読む。\n${FORMAT_HINTS[host]}\n- ファイルは大きく、1行が数十万字になることもある。全体を順に読まず、発話の行を Grep で探し、必要な範囲だけ読む\n- ファイルを書き換えない。会話の記録以外のファイルを探し回らない\n\n${SPEC}`
const FLOOR_PROMPT = '「OK」とだけ返す。'

export function sessionStat(host, path) {
  const text = readFileSync(path, 'utf8')
  const events = parseLines(text)
  let ctxTokens = 0, compactions = 0, carriedCostUsd = 0, carriedApiMs = 0, carriedUsage
  for (const e of events) {
    if (host === 'claude') {
      if (e.isCompactSummary) compactions++
      // claude --resume は、元のセッションが終了時に書いた累計 (cost-state) を引き継ぐので、total_cost_usd と duration_api_ms に元の分が乗る
      if (e.type === 'cost-state') { carriedCostUsd = e.totalCostUSD ?? 0; carriedApiMs = e.totalAPIDuration ?? 0 }
      const u = e.type === 'assistant' && !e.isSidechain ? e.message?.usage : null
      if (u) ctxTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    } else if (e.payload?.type === 'token_count' && e.payload.info) {
      ctxTokens = e.payload.info.last_token_usage.input_tokens
      // codex exec fork の turn.completed.usage は、元のスレッドの累計 (total_token_usage) に今回の分を足した値になる
      const t = e.payload.info.total_token_usage
      carriedUsage = { input: t.input_tokens, cacheRead: t.cached_input_tokens, output: t.output_tokens, reasoning: t.reasoning_output_tokens }
    }
  }
  return { sizeBytes: statSync(path).size, lines: text.split('\n').filter(Boolean).length, ctxTokens, compactions, extractedChars: extract(host, text).length, ...(host === 'claude' && { carriedCostUsd, carriedApiMs }), ...(host === 'codex' && { carriedUsage }) }
}

/* ============ CLI の起動と出力の読み取り ============ */
// fork / resume した CLI が報告する累計から、元のセッションが持っていた分を引き、この呼び出しだけの値にする。
// claude は total_cost_usd と duration_api_ms (usage 自体は呼び出し単位)、codex は turn.completed.usage の全項目
export function removeForkCarry(host, method, meta, stat) {
  if (!/^(F|BF)$/.test(method)) return {}
  if (host === 'claude') {
    return { costUsdReported: meta.costUsd, apiMsReported: meta.apiMs, costUsd: meta.costUsd - (stat.carriedCostUsd ?? 0), apiMs: meta.apiMs - (stat.carriedApiMs ?? 0) }
  }
  const c = stat.carriedUsage ?? {}, u = meta.usage
  return {
    usageReported: u,
    usage: { input: u.input - (c.input ?? 0), cacheRead: u.cacheRead - (c.cacheRead ?? 0), cacheCreate: u.cacheCreate, output: u.output - (c.output ?? 0), reasoning: (u.reasoning ?? 0) - (c.reasoning ?? 0) },
  }
}

// 入力のうちキャッシュから読んだ割合。warm は 0.8 以上、cold は 0.2 未満。fork の数字は warm のものだけを方式の比較に使う
export function cacheState(host, u) {
  const total = host === 'claude' ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheCreate ?? 0) : (u.input ?? 0)
  if (!total) return {}
  const hit = +((u.cacheRead ?? 0) / total).toFixed(2)
  return { cacheHit: hit, cacheState: hit >= 0.8 ? 'warm' : hit < 0.2 ? 'cold' : 'partial' }
}

// codex exec fork は呼び出し元セッションのモデルではなく、config.toml の既定を使う (永続版の fork で turn_context を読んで確かめた)。--json の出力にモデル名は無い
function codexDefaultModel() {
  try {
    const toml = readFileSync(join(process.env.HOME, '.codex', 'config.toml'), 'utf8')
    return `${toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? '?'}/${toml.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? '?'} (config.toml の既定)`
  } catch { return '? (config.toml を読めない)' }
}

function parseClaude(stdout) {
  const out = JSON.parse(stdout)
  const r = Array.isArray(out) ? out.findLast(e => e.type === 'result') : out
  if (!r) throw new Error('result がない')
  const u = r.usage ?? {}
  return {
    text: r.result, isError: !!r.is_error, cliMs: r.duration_ms, apiMs: r.duration_api_ms, numTurns: r.num_turns, costUsd: r.total_cost_usd,
    usage: { input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheCreate: u.cache_creation_input_tokens, output: u.output_tokens },
    models: Object.keys(r.modelUsage ?? {}), toolCalls: undefined,
  }
}

export function parseCodex(stdout) {
  const events = parseLines(stdout)
  const items = events.filter(e => e.type === 'item.completed').map(e => e.item)
  const done = events.findLast(e => e.type === 'turn.completed')
  const failed = events.findLast(e => e.type === 'turn.failed' || e.type === 'error')
  const u = done?.usage ?? {}
  // type が error の item は設定の非推奨警告などで、ツール呼び出しではない
  const toolCalls = items.filter(i => !['agent_message', 'reasoning', 'error'].includes(i.type)).length
  return {
    text: items.findLast(i => i.type === 'agent_message')?.text, isError: !!failed && !done, errorMessage: failed?.message ?? failed?.error?.message,
    numTurns: toolCalls + 1, toolCalls, usage: { input: u.input_tokens, cacheRead: u.cached_input_tokens, cacheCreate: u.cache_write_input_tokens, output: u.output_tokens, reasoning: u.reasoning_output_tokens },
    itemTypes: items.reduce((h, i) => (h[i.type] = (h[i.type] ?? 0) + 1, h), {}),
  }
}

// 軽い起動 (末尾 L の SL / PL / BL)。S/P/B を指定どおりの引数で測ると、ユーザーの MCP サーバーのツール定義や設定が毎回プロンプトに入る。
// それを外した版を並べて、起動時の文脈の重さが時間と費用にどれだけ効いているかを分ける
const LEAN = {
  claude: ['--strict-mcp-config'],
  codex: ['--ignore-user-config', '--ignore-rules', '-c', 'model_reasoning_effort="low"'],
}

// 各方式の起動引数・作業ディレクトリ・標準入力。S/P/B は会話に紐づかないので中立のディレクトリで動かす
function buildInvocation({ host, method, session, neutralCwd, maxBudgetUsd }) {
  const lean = method.length === 2 && method.endsWith('L') ? LEAN[host] : []
  const base = lean.length ? method[0] : method
  const fork = host === 'claude'
    ? ['-p', '--resume', session?.id, '--fork-session', '--no-session-persistence', '--output-format', 'json']
    : ['-a', 'never', 'exec', '-s', 'read-only', 'fork', '--skip-git-repo-check', '--ephemeral', '--json', session?.id, '-']
  const fresh = (...extra) => host === 'claude'
    ? ['-p', '--model', SUMMARIZER_MODEL.claude, '--no-session-persistence', '--output-format', 'json', ...extra, ...lean]
    : ['-a', 'never', 'exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '-m', SUMMARIZER_MODEL.codex, ...extra, ...lean, '-']
  switch (base) {
    case 'F': return { argv: fork, cwd: session.cwd, prompt: forkPrompt() }
    case 'BF': return { argv: fork, cwd: session.cwd, prompt: FLOOR_PROMPT }
    case 'S': return {
      argv: host === 'claude' ? fresh('--tools', 'Read,Grep,Glob', '--add-dir', dirname(session.jsonl), '--max-budget-usd', String(maxBudgetUsd)) : fresh(),
      cwd: neutralCwd, prompt: summarizerPrompt(host, session.jsonl),
    }
    case 'P': {
      const text = extract(host, readFileSync(session.jsonl, 'utf8'))
      return { argv: host === 'claude' ? fresh('--tools', '') : fresh(), cwd: neutralCwd, prompt: prefilteredPrompt(text), extractedChars: text.length }
    }
    case 'B': return { argv: host === 'claude' ? fresh('--tools', '') : fresh(), cwd: neutralCwd, prompt: FLOOR_PROMPT }
    default: throw new Error(`未知の方式: ${method}`)
  }
}

function spawnCli(bin, argv, cwd, prompt, timeoutMs) {
  // 計測する側のエージェント盤 (HC_TERMINAL_ID) を子の claude / codex が汚さないようにする
  const env = { ...process.env }
  delete env.HC_TERMINAL_ID
  const start = performance.now()
  return new Promise(resolvePromise => {
    const child = spawn(bin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000) }, timeoutMs)
    child.on('error', error => { clearTimeout(timer); resolvePromise({ stdout, stderr: stderr + String(error), exitCode: -1, timedOut, wallMs: Math.round(performance.now() - start) }) })
    child.on('close', exitCode => { clearTimeout(timer); resolvePromise({ stdout, stderr, exitCode, timedOut, wallMs: Math.round(performance.now() - start) }) })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

async function runCell(cell, plan, outDir) {
  const session = cell.session ? plan.sessions[cell.session] : undefined
  if (cell.session && !session) throw new Error(`plan に無いセッション: ${cell.session}`)
  const host = session?.host ?? cell.host
  const id = `${cell.session ?? host}-${cell.method}-${cell.run}`
  const neutralCwd = join(outDir, 'neutral-cwd')
  mkdirSync(neutralCwd, { recursive: true })
  const inv = buildInvocation({ host, method: cell.method, session, neutralCwd, maxBudgetUsd: plan.maxBudgetUsd ?? 5 })
  let attempt = 1
  while (existsSync(join(outDir, 'runs', `${id}-a${attempt}`))) attempt++
  const dir = join(outDir, 'runs', `${id}-a${attempt}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'prompt.txt'), inv.prompt)

  // 呼び出し元のセッションは生きていて伸びるので、実行ごとに大きさを測り直す
  const record = {
    id, attempt, host, session: cell.session, label: session?.label, method: cell.method, run: cell.run, startedAt: new Date().toISOString(), loadAvg1: +loadavg()[0].toFixed(2),
    sessionStat: session ? sessionStat(host, session.jsonl) : undefined, promptChars: inv.prompt.length, extractedChars: inv.extractedChars, argv: inv.argv,
  }
  const res = await spawnCli(host, inv.argv, inv.cwd, inv.prompt, (plan.timeoutSec ?? 900) * 1000)
  writeFileSync(join(dir, 'stdout.txt'), res.stdout)
  writeFileSync(join(dir, 'stderr.txt'), res.stderr)
  Object.assign(record, { wallMs: res.wallMs, exitCode: res.exitCode, timedOut: res.timedOut, stdoutBytes: res.stdout.length })

  try {
    if (res.timedOut) throw new Error(`${plan.timeoutSec ?? 900} 秒でタイムアウト`)
    const parsed = host === 'claude' ? parseClaude(res.stdout) : parseCodex(res.stdout)
    const { text, ...meta } = parsed
    Object.assign(record, meta, removeForkCarry(host, cell.method, meta, record.sessionStat))
    Object.assign(record, cacheState(host, record.usage))
    if (host === 'codex') record.models = [cell.method.startsWith('F') || cell.method === 'BF' ? codexDefaultModel() : `${SUMMARIZER_MODEL.codex}/low`]
    // fork はツール一式を持ったまま動くので、プロンプトの「ツールは使わない」が守られたかを確かめる
    if (cell.method === 'F') record.forkUsedTools = host === 'claude' ? meta.numTurns > 1 : (meta.toolCalls ?? 0) > 0
    if (res.exitCode !== 0) throw new Error(`終了コード ${res.exitCode}${meta.errorMessage ? `: ${meta.errorMessage}` : ''}`)
    if (meta.isError) throw new Error(`CLI がエラーを返した: ${String(text ?? meta.errorMessage).slice(0, 300)}`)
    if (['B', 'BL', 'BF'].includes(cell.method)) { record.floorReply = String(text).slice(0, 40); record.valid = null }
    else {
      const inventory = modelJson(text)
      writeFileSync(join(dir, 'inventory.json'), JSON.stringify(inventory, null, 2))
      const errors = validateInventory(inventory)
      Object.assign(record, { valid: errors.length === 0, validationErrors: errors.slice(0, 10), openCount: inventory.open?.length, factsCount: inventory.facts?.length, overPromptCap: inventory.open?.length > CAPS.open || inventory.facts?.length > CAPS.facts })
    }
  } catch (error) {
    record.error = error.message
    record.valid = false
  }
  writeFileSync(join(dir, 'run.json'), JSON.stringify(record, null, 2))
  appendFileSync(join(outDir, 'results.jsonl'), JSON.stringify(record) + '\n')
  return record
}

/* ============ 結果の表と並べ読み ============ */
const readResults = outDir => existsSync(join(outDir, 'results.jsonl')) ? parseLines(readFileSync(join(outDir, 'results.jsonl'), 'utf8')) : []
const sec = ms => ms == null ? '-' : (ms / 1000).toFixed(1)
const kfmt = n => n == null ? '-' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

function reportTable(rows) {
  const head = '| id | attempt | wall s | CLI s | API s | cost USD | input | cache read | cache write | output | cache | turns | tools | fork used tools | valid | open | facts | models / error |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  const lines = rows.map(r => `| ${r.id} | ${r.attempt} | ${sec(r.wallMs)} | ${sec(r.cliMs)} | ${sec(r.apiMs)} | ${r.costUsd?.toFixed(3) ?? '-'} | ${kfmt(r.usage?.input)} | ${kfmt(r.usage?.cacheRead)} | ${kfmt(r.usage?.cacheCreate)} | ${kfmt(r.usage?.output)} | ${r.cacheState ?? '-'} | ${r.numTurns ?? '-'} | ${r.toolCalls ?? '-'} | ${r.forkUsedTools ?? '-'} | ${r.valid === null ? 'floor' : r.valid ? 'yes' : 'NO'} | ${r.openCount ?? '-'} | ${r.factsCount ?? '-'} | ${r.error ? `ERR ${r.error.slice(0, 80)}` : (r.models ?? []).join(',')} |`)
  return [head, ...lines].join('\n')
}

function inventoryMarkdown(inv) {
  const open = (inv.open ?? []).map(o => `- **${o.topic}** (${o.widget}${o.multiple ? ', 複数可' : ''}): ${o.question}\n  - 候補: ${(o.options ?? []).join(' / ') || '(なし)'}\n  - 出どころ: ${o.source}`).join('\n')
  const facts = (inv.facts ?? []).map(f => `- **${f.topic}**: ${f.value}\n  - 出どころ: ${f.source}`).join('\n')
  return `#### 未決の論点 (${inv.open?.length ?? 0})\n${open || '(なし)'}\n\n#### 決定済みの事実 (${inv.facts?.length ?? 0})\n${facts || '(なし)'}`
}

function writeReviews(outDir) {
  const bySession = {}
  for (const r of readResults(outDir)) if (r.session && r.valid !== null) (bySession[r.session] ??= []).push(r)
  for (const [key, rows] of Object.entries(bySession)) {
    const latest = {}
    for (const r of rows) if (r.run === 1 && existsSync(join(outDir, 'runs', `${r.id}-a${r.attempt}`, 'inventory.json'))) latest[r.method] = r
    const first = rows[0]
    const parts = [`# ${key} の在庫の並べ読み\n\nhost: ${first.host}、会話の文脈: 約 ${first.sessionStat?.ctxTokens} tokens、jsonl: ${(first.sessionStat?.sizeBytes / 1e6).toFixed(1)} MB、P 方式の本文: ${first.sessionStat?.extractedChars} 字\n`]
    for (const method of ['F', 'S', 'SL', 'P', 'PL']) {
      const r = latest[method]
      if (!r) { parts.push(`## ${method}\n(在庫なし)\n`); continue }
      const inv = JSON.parse(readFileSync(join(outDir, 'runs', `${r.id}-a${r.attempt}`, 'inventory.json'), 'utf8'))
      parts.push(`## ${method} (${r.id}-a${r.attempt}、${sec(r.wallMs)} 秒、valid=${r.valid}、model=${(r.models ?? []).join(',')}、cache=${r.cacheState})\n\n${inventoryMarkdown(inv)}\n`)
    }
    // 人が書いた所見は assessment-<key>.md に置き、並べ読みの末尾に付ける (再生成しても消えない)
    const assessment = join(outDir, `assessment-${key}.md`)
    if (existsSync(assessment)) parts.push(readFileSync(assessment, 'utf8'))
    writeFileSync(join(outDir, `review-${key}.md`), parts.join('\n'))
  }
  return Object.keys(bySession)
}

/* ============ 自己検証 ============ */
async function selftest() {
  const good = { open: [{ topic: 't', question: 'q', widget: 'chips', options: ['a', 'b'], multiple: true, source: 's' }, { topic: 'r', question: 'q', widget: 'range', options: ['歳'], multiple: false, source: 's' }, { topic: 'x', question: 'q', widget: 'text', options: [], multiple: false, source: 's' }], facts: [{ topic: 't', value: 'v', source: 's' }] }
  assert.deepEqual(validateInventory(good), [])
  assert.ok(validateInventory({ open: [], facts: [{ topic: 't', value: '', source: 's' }] }).length)
  assert.ok(validateInventory({ ...good, open: [{ ...good.open[0], widget: 'slider' }] }).length)
  assert.ok(validateInventory({ ...good, open: [{ ...good.open[0], options: ['a'] }] }).length)
  assert.ok(validateInventory({ ...good, open: [{ ...good.open[0], multiple: 'yes' }] }).length)
  assert.ok(validateInventory([]).length)
  assert.deepEqual(modelJson('前置き\n```json\n{"a":1}\n```'), { a: 1 })
  assert.throws(() => modelJson('なし'))

  const line = o => JSON.stringify(o)
  const claude = [
    line({ type: 'user', message: { content: '古い発話' } }),
    line({ type: 'user', isCompactSummary: true, message: { content: '要約の本文' } }),
    line({ type: 'user', message: { content: [{ type: 'text', text: '依頼<system-reminder>注入</system-reminder>' }] } }),
    line({ type: 'user', isMeta: true, message: { content: 'メタ' } }),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '子の発話' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '返事' }, { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ question: 'どっち?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ls の出力' }, { type: 'tool_result', tool_use_id: 'q', content: [{ type: 'text', text: 'A を選んだ' }] }] } }),
  ].join('\n')
  const c = extractClaude(claude)
  for (const keep of ['[会話の要約] 要約の本文', '[ユーザー] 依頼', '[アシスタント] 返事', 'どっち?', '候補: A / B', '[ユーザーの回答] A を選んだ']) assert.ok(c.includes(keep), keep)
  for (const drop of ['古い発話', '注入', 'メタ', '子の発話', '思考', 'ls の出力']) assert.ok(!c.includes(drop), drop)

  const codex = [
    line({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'システム' }] } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n...' }, { type: 'input_text', text: '<environment_context>x</environment_context>' }] } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<image name=[Image #1]>' }, { type: 'input_image', image_url: 'data:...' }, { type: 'input_text', text: '</image>' }, { type: 'input_text', text: '依頼です' }] } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '返事です' }] } }),
    line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }),
  ].join('\n')
  assert.equal(extractCodex(codex), '[ユーザー] [画像]\n依頼です\n\n[アシスタント] 返事です')
  const reply = line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<send_user_message_question_reply>[{"answer":"はい"}]</send_user_message_question_reply>' }] } })
  assert.ok(extractCodex(reply).startsWith('[ユーザーの回答] '))
  const note = line({ type: 'user', message: { content: '<task-notification><summary>done</summary></task-notification>' } })
  assert.ok(extractClaude(note).startsWith('[通知] ') && !extractClaude(note).includes('[ユーザー]'))
  const queuedLines = [
    line({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: [{ type: 'text', text: '作業中に打った依頼' }, { type: 'image', source: { data: 'xxxx' } }] } }),
    line({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'peer' }, isMeta: true, prompt: '他エージェントの長い報告' } }),
    line({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'task-notification' }, prompt: '完了通知' } }),
    line({ type: 'attachment', attachment: { type: 'environment' } }),
  ].join('\n')
  assert.equal(extractClaude(queuedLines), '[ユーザー] 作業中に打った依頼\n\n[ユーザー] [画像]\n\n[通知] 完了通知')
  const forked = removeForkCarry('codex', 'F', { usage: { input: 5280, cacheRead: 5167, cacheCreate: 0, output: 20, reasoning: 0 } }, { carriedUsage: { input: 5152, cacheRead: 5040, output: 18, reasoning: 0 } })
  assert.deepEqual([forked.usage.input, forked.usage.cacheRead, forked.usage.output], [128, 127, 2])
  assert.equal(removeForkCarry('claude', 'F', { costUsd: 12.86, apiMs: 30000 }, { carriedCostUsd: 12.1, carriedApiMs: 20000 }).apiMs, 10000)
  assert.deepEqual(removeForkCarry('codex', 'P', {}, {}), {})
  assert.equal(parseCodex([{ type: 'item.completed', item: { type: 'error', message: '警告' } }, { type: 'item.completed', item: { type: 'agent_message', text: '{}' } }, { type: 'turn.completed', usage: {} }].map(line).join('\n')).toolCalls, 0)
  assert.equal(cacheState('claude', { input: 2, cacheRead: 900, cacheCreate: 98 }).cacheState, 'warm')
  assert.equal(cacheState('claude', { input: 2, cacheRead: 0, cacheCreate: 1000 }).cacheState, 'cold')
  assert.equal(cacheState('codex', { input: 1000, cacheRead: 500 }).cacheState, 'partial')

  const events = [{ type: 'thread.started' }, { type: 'item.completed', item: { type: 'command_execution' } }, { type: 'item.completed', item: { type: 'agent_message', text: '{"open":[],"facts":[]}' } }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } }].map(line).join('\n')
  const p = parseCodex(events)
  assert.deepEqual([p.text, p.usage.cacheRead, p.toolCalls, p.numTurns], ['{"open":[],"facts":[]}', 4, 1, 2])

  // 記録の場所: claude は作業ディレクトリの / と . を - に替えたディレクトリ、codex は日付のディレクトリを探してファイル名の末尾で合わせる
  const home = mkdtempSync(join(tmpdir(), 'inventory-selftest-'))
  try {
    const cwd = '/Users/me/ghq/github.com/me/repo/.worktrees/x'
    const claudePath = join(home, '.claude', 'projects', '-Users-me-ghq-github-com-me-repo--worktrees-x', 'sess-1.jsonl')
    mkdirSync(dirname(claudePath), { recursive: true }); writeFileSync(claudePath, '')
    assert.equal(await locateTranscript('claude', 'sess-1', { home, cwd }), claudePath)
    assert.equal(await locateTranscript('claude', 'sess-2', { home, cwd }), null)
    assert.equal(await locateTranscript('codex', 'abc-123', { home }), null)
    const rollout = join(home, '.codex', 'sessions', '2026', '11', '21', 'rollout-2026-11-21T10-00-00-abc-123.jsonl')
    mkdirSync(dirname(rollout), { recursive: true }); writeFileSync(rollout, '')
    assert.equal(await locateTranscript('codex', 'abc-123', { home }), rollout)
    assert.equal(await locateTranscript('codex', 'bc-123', { home }), null)
    assert.equal(await locateTranscript('codex', 'zzz', { home }), null)
  } finally { rmSync(home, { recursive: true, force: true }) }
  console.log('selftest ok')
}

/* ============ 入口 ============ */
async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({ args: rest, options: { plan: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' }, dry: { type: 'boolean' }, host: { type: 'string' }, jsonl: { type: 'string' } } })
  const needOut = () => { if (!values.out) throw new Error('--out DIR を指定してください'); return resolve(values.out) }
  switch (command) {
    case 'selftest': await selftest(); break
    case 'extract': console.log(extract(values.host, readFileSync(values.jsonl, 'utf8'))); break
    case 'stat': console.log(JSON.stringify(sessionStat(values.host, values.jsonl))); break
    case 'report': {
      const outDir = needOut()
      const table = reportTable(readResults(outDir))
      writeFileSync(join(outDir, 'results.md'), table + '\n')
      console.log(table)
      break
    }
    case 'review': console.log('書いた:', writeReviews(needOut()).map(k => `review-${k}.md`).join(', ')); break
    case 'run': {
      const outDir = needOut()
      const plan = JSON.parse(readFileSync(values.plan, 'utf8'))
      mkdirSync(outDir, { recursive: true })
      const only = values.only?.split(',')
      for (const cell of plan.cells) {
        const id = `${cell.session ?? cell.host}-${cell.method}-${cell.run}`
        if (only && !only.includes(id)) continue
        if (values.dry) {
          const session = cell.session ? plan.sessions[cell.session] : undefined
          const inv = buildInvocation({ host: session?.host ?? cell.host, method: cell.method, session, neutralCwd: join(outDir, 'neutral-cwd'), maxBudgetUsd: plan.maxBudgetUsd ?? 5 })
          console.log(`${id}: (cwd ${inv.cwd}) ${session?.host ?? cell.host} ${inv.argv.join(' ')}  <- prompt ${inv.prompt.length} 字`)
          continue
        }
        const r = await runCell(cell, plan, outDir)
        console.error(`${r.id}-a${r.attempt}: ${sec(r.wallMs)}s cost=${r.costUsd?.toFixed?.(3) ?? '-'} turns=${r.numTurns ?? '-'} valid=${r.valid} open=${r.openCount ?? '-'} facts=${r.factsCount ?? '-'}${r.error ? ` ERROR ${r.error}` : ''}`)
      }
      break
    }
    default: throw new Error('コマンドは run / report / review / extract / stat / selftest のいずれか')
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(error.message); process.exit(1) })
