/* 在庫 (inventory) の領域知識。会話から「未決の論点」と「決定済みの事実」を集めるための、
   プロンプト・形の検証・会話の記録の抜き出し・記録の場所の特定を1か所に持つ。
   server.mjs (起動時に在庫を作る) と tools/measure-inventory.mjs (作り方の計測) が共有する。Issue #2。 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const WIDGETS = ['single', 'chips', 'range', 'text']
export const CAPS = { open: 5, facts: 8 }

/* ============ 在庫の形の検証 ============ */
export function validateInventory(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['トップレベルがオブジェクトではない']
  const errors = []
  const str = (x, path) => { if (typeof x !== 'string' || !x.trim()) errors.push(`${path} が空でない文字列ではない`) }
  if (!Array.isArray(v.open)) errors.push('open が配列ではない')
  if (!Array.isArray(v.facts)) errors.push('facts が配列ではない')
  ;(Array.isArray(v.open) ? v.open : []).forEach((o, i) => {
    const at = `open[${i}]`
    if (!o || typeof o !== 'object') { errors.push(`${at} がオブジェクトではない`); return }
    for (const k of ['topic', 'question', 'source']) str(o[k], `${at}.${k}`)
    if (!WIDGETS.includes(o.widget)) errors.push(`${at}.widget が ${WIDGETS.join('/')} のいずれかではない`)
    if (typeof o.multiple !== 'boolean') errors.push(`${at}.multiple が真偽値ではない`)
    if (!Array.isArray(o.options) || o.options.some(x => typeof x !== 'string' || !x.trim())) errors.push(`${at}.options が文字列の配列ではない`)
    else if ((o.widget === 'single' || o.widget === 'chips') && o.options.length < 2) errors.push(`${at}.options が ${o.widget} なのに2個未満`)
    else if (o.widget === 'range' && o.options.length > 1) errors.push(`${at}.options が range なのに単位1個以下ではない`)
  })
  ;(Array.isArray(v.facts) ? v.facts : []).forEach((f, i) => {
    if (!f || typeof f !== 'object') { errors.push(`facts[${i}] がオブジェクトではない`); return }
    for (const k of ['topic', 'value', 'source']) str(f[k], `facts[${i}].${k}`)
  })
  return errors
}

// モデルの出力から最も外側の JSON オブジェクトを取り出す (コードフェンスや前置きを許す)
export function modelJson(text) {
  const first = typeof text === 'string' ? text.indexOf('{') : -1, last = typeof text === 'string' ? text.lastIndexOf('}') : -1
  if (first < 0 || last < first) throw new Error('JSON オブジェクトが見つかりません')
  try { return JSON.parse(text.slice(first, last + 1)) } catch { throw new Error('JSON として読めません') }
}

/* ============ プロンプト ============ */
export const SPEC = `## 作るもの: 在庫
会話の文脈から、次の形の JSON オブジェクトを1つ作る。ユーザーがこのあと付箋に依頼を書いたとき、AI が聞き返したくなる論点と、聞き返してはいけない決定済みの事実を、先に集めておくためのもの。

{
  "open": [ { "topic": "...", "question": "...", "widget": "single", "options": ["...", "..."], "multiple": false, "source": "..." } ],
  "facts": [ { "topic": "...", "value": "...", "source": "..." } ]
}

- open は、会話の中でまだ決まっていない判断。ユーザーが答えていない問い、保留にされた事柄、候補が並んだまま結論が出ていない事柄。最大${CAPS.open}件。重要なものから並べる。未決のものが無ければ空配列にし、作り足さない
  - topic は論点の短い名前 (20字以内)、question はユーザーに聞く問い (80字以内)
  - widget は single (1つ選ぶ) / chips (候補から選ぶ。複数可) / range (年齢・人数・期間など連続する量) / text (自由記述) のいずれか
  - options は、single と chips では会話に出た候補を中心に2〜6個。range では単位だけを1個 (例: ["歳"]) か空配列にし、最小や最大は書かない。text では空配列
  - multiple は、複数選べるなら true
  - source は、会話のどこから来たか。短い引用か言い換え (40字以内)
- facts は、ユーザーが明言したか、AI の提案をユーザーが了承したことだけ。AI が仮に置いただけのことや、AI の説明や推測は facts にせず、未決なら open に入れる。最大${CAPS.facts}件
  - topic は事柄の短い名前、value は決まった内容、source は会話のどこで決まったか (40字以内)
- 会話に無いことは足さない。推測で埋めない。日本語で書く
- JSON オブジェクトを1つだけ返す。前置き、説明、コードフェンスは付けない`

// 発話だけを抜き出した本文 (extract の出力) から在庫を作らせるプロンプト
export const prefilteredPrompt = text => `あなたは、会話の記録から「在庫」を作る係です。次の「会話の記録」は、ユーザーとアシスタントの発話だけを抜き出したもので、ツールの出力や作業の途中経過は含まれない。ツールは使わず、ファイルも読まない。\n\n${SPEC}\n\n## 会話の記録\n${text}`

/* ============ 発話の抜き出し ============ */
const stripReminders = s => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

const askText = input => (input?.questions ?? []).map(q => `- ${q.question} (候補: ${(q.options ?? []).map(o => o.label).join(' / ')}${q.multiSelect ? '、複数可' : ''})`).join('\n')
const resultText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''

export const parseLines = text => text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })

// AskUserQuestion は道具の形をした対話そのものなので、tool_use / tool_result のうちこれだけ残す
export function extractClaude(jsonlText) {
  const events = parseLines(jsonlText)
  const start = events.findLastIndex(e => e.isCompactSummary)
  const asks = new Set(), out = []
  for (const e of events.slice(Math.max(start, 0))) {
    if (e.isSidechain || e.isMeta) continue
    const c = e.message?.content
    // アシスタントの作業中に打ったユーザーの発話は、user ではなく queued_command の添付として残る。peer (他エージェントの報告) は作業の記録として落とす
    const queued = e.type === 'attachment' && e.attachment?.type === 'queued_command' && !e.attachment.isMeta ? e.attachment : null
    if (queued && ['human', 'task-notification'].includes(queued.origin?.kind)) {
      const label = queued.origin.kind === 'human' ? 'ユーザー' : '通知'
      for (const b of typeof queued.prompt === 'string' ? [{ type: 'text', text: queued.prompt }] : Array.isArray(queued.prompt) ? queued.prompt : []) {
        if (b.type === 'text') { const t = stripReminders(b.text); if (t) out.push(`[${label}] ${t}`) }
        else if (b.type === 'image') out.push(`[${label}] [画像]`)
      }
    } else if (e.type === 'user') {
      for (const b of typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []) {
        // <task-notification> はユーザーの発話の形でハーネスが入れる、子エージェントの完了通知。ユーザーの発話にしない
        if (b.type === 'text') { const t = stripReminders(b.text); if (t) out.push(`[${e.isCompactSummary ? '会話の要約' : t.startsWith('<task-notification>') ? '通知' : 'ユーザー'}] ${t}`) }
        else if (b.type === 'image') out.push('[ユーザー] [画像]')
        else if (b.type === 'tool_result' && asks.has(b.tool_use_id)) out.push(`[ユーザーの回答] ${resultText(b.content)}`)
      }
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) out.push(`[アシスタント] ${b.text.trim()}`)
        else if (b.type === 'tool_use' && b.name === 'AskUserQuestion') { asks.add(b.id); out.push(`[アシスタントの質問]\n${askText(b.input)}`) }
      }
    }
  }
  return out.join('\n\n')
}

const CODEX_SYSTEM_PARTS = ['# AGENTS.md instructions', '<environment_context>', '<skill>', '<user_instructions>', '<permissions instructions>']
export function extractCodex(jsonlText) {
  const out = []
  for (const e of parseLines(jsonlText)) {
    if (e.type !== 'response_item' || e.payload?.type !== 'message' || !['user', 'assistant'].includes(e.payload.role)) continue
    const parts = e.payload.content.map(c => c.type === 'input_image' ? '[画像]' : (c.text ?? '')).filter(t => t.trim() && !(e.payload.role === 'user' && CODEX_SYSTEM_PARTS.some(p => t.trimStart().startsWith(p))))
    // <image name=...> と </image> は画像の囲みなので落とす
    const text = parts.filter(t => !/^<\/?image\b/.test(t.trim())).join('\n').trim()
    const label = e.payload.role === 'assistant' ? 'アシスタント' : text.startsWith('<send_user_message_question_reply>') ? 'ユーザーの回答' : 'ユーザー'
    if (text) out.push(`[${label}] ${text}`)
  }
  return out.join('\n\n')
}
export const extract = (host, jsonlText) => host === 'claude' ? extractClaude(jsonlText) : extractCodex(jsonlText)

/* ============ 会話の記録の場所 ============
   呼び出し元のセッションの jsonl を探す。見つからなければ null。会話をまだ始めていないセッションには
   記録が無いことがあるので、無いのはエラーにしない。session は起動引数の検証を通った値で、パスの区切りを含まない。 */
const isFile = path => stat(path).then(s => s.isFile(), () => false)

// 日付のディレクトリ (YYYY/MM/DD) を新しい順にたどり、ファイル名だけで探す。中身は読まない
async function findRollout(dir, suffix) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return null }
  entries.sort((a, b) => (a.name < b.name ? 1 : -1))
  for (const e of entries) {
    const hit = e.isDirectory() ? await findRollout(join(dir, e.name), suffix) : e.name.endsWith(suffix) ? join(dir, e.name) : null
    if (hit) return hit
  }
  return null
}

export async function locateTranscript(host, session, { home = homedir(), cwd = process.cwd() } = {}) {
  if (host === 'claude') {
    // Claude Code はプロジェクトのディレクトリ名を、作業ディレクトリの英数字以外を - に替えて作る (例: c_3h は c-3h になる)
    const path = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`)
    return (await isFile(path)) ? path : null
  }
  return findRollout(join(home, '.codex', 'sessions'), `-${session}.jsonl`)
}
