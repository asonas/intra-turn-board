import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/* ============ ホスト ============
   呼び出し元のエージェントごとに、CLI の引数の組み立てと標準出力の読み方を1か所に持つ。
   どちらも ephemeral な fork なので、セッションの台帳や後片付けは要らない。 */
const HOSTS = {
  claude: {
    bin: 'claude',
    // --tools と --json-schema は渡さない。ツール定義が呼び出し元のセッションと変わると、fork がプロンプトキャッシュを使えず遅く高くなる
    argv: ({ session, model, effort }) => [
      '-p', '--resume', session, '--fork-session', '--no-session-persistence', '--output-format', 'json',
      ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
    ],
    prompt: (stagePrompt, schema) => [
      stagePrompt,
      section('出力の形式', 'スキーマに合う JSON オブジェクトを1つだけ返す。前置きや説明の文章、コードフェンスは付けない。'),
      section('JSON Schema', schema.json),
    ].join('\n\n'),
    parse(stdout) {
      const out = JSON.parse(stdout)
      const result = Array.isArray(out) ? out.findLast(e => e.type === 'result') : out
      if (!result || result.is_error) throw new Error(`Claude がエラーを返しました: ${result?.result ?? '応答がありません'}`)
      const u = result.usage ?? {}
      return {
        value: modelJson(result.result),
        cost_usd: result.total_cost_usd,
        usage: { input_tokens: u.input_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, output_tokens: u.output_tokens },
      }
    },
  },
  codex: {
    bin: 'codex',
    argv: ({ session, schema, model, effort }) => [
      '-a', 'never', 'exec', '-s', 'read-only', 'fork', '--ephemeral', '--json', '--output-schema', schema.path,
      ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
      session, '-',
    ],
    prompt: stagePrompt => stagePrompt,
    parse(stdout) {
      const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      const message = events.findLast(e => e.type === 'item.completed' && e.item.type === 'agent_message')?.item.text
      if (!message?.trim()) throw new Error('Codex の応答が空です')
      return { value: JSON.parse(message), usage: events.findLast(e => e.type === 'turn.completed')?.usage }
    },
  },
}

// 起動時の引数を検証して、以降は検証済みの値だけを使う
function resolveConfig(argv, env) {
  let values
  try { ({ values } = parseArgs({ args: argv, options: { host: { type: 'string' }, session: { type: 'string' } } })) } catch (error) { throw new Error(`引数が不正です: ${error.message.split('\n')[0]}`) }
  const host = values.host ?? (env.CODEX_THREAD_ID ? 'codex' : undefined)
  if (!host || !(host in HOSTS)) throw new Error(`--host に ${Object.keys(HOSTS).join(' か ')} を指定してください (例: node server.mjs --host claude --session <セッションID>)`)
  const session = values.session ?? (host === 'codex' ? env.CODEX_THREAD_ID : undefined)
  // 先頭が - の値は CLI のオプションとして解釈されるので通さない
  if (!session || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(session)) throw new Error('--session に呼び出し元のセッション ID を指定してください')
  const model = env.INTRA_TURN_MODEL || undefined, effort = env.INTRA_TURN_EFFORT || undefined
  if (model && !/^[A-Za-z0-9][\w.:[\]-]{0,63}$/.test(model)) throw new Error('INTRA_TURN_MODEL の値が不正です')
  if (effort && !/^[a-z]{3,10}$/.test(effort)) throw new Error('INTRA_TURN_EFFORT の値が不正です')
  return { host, session, model, effort }
}

/* ============ 入力と出力の検証 ============ */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const bad = message => new HttpError(400, message)
// モデルの出力が形式を外れたとき。ボードには渡さず、画面に出せる文にして返す
const invalid = message => new HttpError(502, `AI の出力が想定の形式ではありませんでした (${message})`)

// コードフェンスや前後の空白を許して、最も外側の JSON オブジェクトを取り出す
function modelJson(text) {
  const first = typeof text === 'string' ? text.indexOf('{') : -1, last = typeof text === 'string' ? text.lastIndexOf('}') : -1
  if (first < 0 || last < first) throw invalid('JSON オブジェクトが見つかりません')
  try { return JSON.parse(text.slice(first, last + 1)) } catch { throw invalid('JSON として読めません') }
}

const KEY = /^[a-z][a-z0-9_]{0,31}$/
const MARKER = /\[\[([^\]]*)\]\]/g
const KINDS = ['heading', 'paragraph', 'item', 'quote']

function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw bad(`${name} は1〜${max}文字で指定してください`)
  return value
}
function list(value, name, max, each) {
  if (!Array.isArray(value) || value.length > max) throw bad(`${name} は${max}件までの配列で指定してください`)
  return value.map(each)
}
function noteInput(body) {
  if (!body || typeof body !== 'object') throw bad('リクエストの形式が不正です')
  return {
    text: text(body.text, 'text', 8000),
    assumptions: list(body.assumptions, 'assumptions', 20, a => text(a, 'assumptions', 300)),
    quote: body.quote == null ? null : text(body.quote, 'quote', 4000),
  }
}
function continueInput(body) {
  const input = noteInput(body)
  const filled = list(body.filled, 'filled', 8, f => {
    if (!f || typeof f !== 'object' || !KEY.test(f.key)) throw bad('filled の key が不正です')
    return { key: f.key, label: text(f.label, 'label', 100), value: text(f.value, 'value', 500) }
  })
  if (!filled.length) throw bad('filled が空です')
  return { ...input, draft: text(body.draft, 'draft', 20000), filled }
}

// blocks を検証して、本文が参照する [[key]] の集合を返す。allowed に無いキーはボードに出ると文字化けになるので落とす
function checkBlocks(blocks, allowed) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 40) throw invalid('blocks は1〜40件の配列にしてください')
  const used = new Set()
  for (const b of blocks) {
    if (!KINDS.includes(b?.kind)) throw invalid(`kind は ${KINDS.join(' / ')} のいずれかにしてください`)
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 2000) throw invalid('text は1〜2000文字にしてください')
    for (const [, key] of b.text.matchAll(MARKER)) {
      if (!allowed.has(key)) throw invalid(`本文の [[${key}]] が宣言されていません`)
      used.add(key)
    }
  }
  return used
}
const plainBlocks = blocks => blocks.map(({ kind, text }) => ({ kind, text }))

function checkDraft(value) {
  const blanks = value?.blanks
  if (!Array.isArray(blanks) || !blanks.length || blanks.length > 5) throw invalid('blanks は1〜5件の配列にしてください')
  const keys = new Set()
  for (const b of blanks) {
    if (!KEY.test(b?.key)) throw invalid('空欄の key は英小文字で始まる英数字とアンダースコア (32文字以内) にしてください')
    if (keys.has(b.key)) throw invalid(`空欄の key ${b.key} が重複しています`)
    keys.add(b.key)
    if (typeof b.label !== 'string' || !b.label.trim() || b.label.length > 40) throw invalid('label は1〜40文字にしてください')
    if (typeof b.question !== 'string' || !b.question.trim() || b.question.length > 120) throw invalid('question は1〜120文字にしてください')
    if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 5 || b.options.some(o => typeof o !== 'string' || !o.trim() || o.length > 60)) throw invalid('options は2〜5個の短い文字列にしてください')
    if (typeof b.multiple !== 'boolean') throw invalid('multiple は真偽値にしてください')
  }
  const used = checkBlocks(value.blocks, keys)
  for (const key of keys) if (!used.has(key)) throw invalid(`空欄 ${key} が本文に置かれていません`)
  return {
    blocks: plainBlocks(value.blocks),
    blanks: blanks.map(({ key, label, question, options, multiple }) => ({ key, label, question, options, multiple })),
  }
}
function checkContinuation(value, input) {
  checkBlocks(value?.blocks, new Set(input.filled.map(f => f.key)))
  return { blocks: plainBlocks(value.blocks) }
}

/* ============ プロンプト ============ */
const section = (title, body) => `## ${title}\n${body}`
const bullets = items => items.map(s => `- ${s}`).join('\n')

function noteSections({ text, assumptions, quote }) {
  return [
    section('ユーザーの付箋', text),
    quote && section('付箋が引用している、あなたの返事の一節', quote),
    assumptions.length && section('入力中に確認済みの前提 (聞き返さず、決まったこととして扱う)', bullets(assumptions)),
  ]
}
const COMMON = ['ツールは使わず、ファイルも読まない', '日本語で書く', 'text は Markdown 記法を使わないプレーンテキストにする']

function draftPrompt(input) {
  return [
    'あなたは、ユーザーが付箋に書いた依頼に返事を書く書き手です。これまでの会話の文脈を踏まえて、返事の書き出しを作ってください。',
    ...noteSections(input),
    section('書き方', bullets([
      '依頼された成果物を、前置きや確認なしですぐ書き始める',
      '全体で日本語200字程度の短さにする',
      '本当にユーザーが決めるべき判断を2〜3個だけ選び、本文の中に [[key]] と書いて空欄として残す。確認済みの前提は空欄にしない',
      '空欄を含む文までで止める。その先の内容は書かない',
      '空欄は blanks にも宣言する。key は英小文字で始まる英数字とアンダースコア (32文字以内)、label は空欄に表示する短い名前、question はユーザーへの問い、options は空欄に代入すると文が成立する短い候補 (2〜5個)、multiple は複数選べるなら true',
      '宣言した key はすべて本文に1回以上置き、本文には宣言した key だけを置く',
      'blocks の kind は heading / paragraph / item / quote のいずれか',
      ...COMMON,
    ])),
  ].filter(Boolean).join('\n\n')
}
function continuePrompt(input) {
  return [
    'あなたは、ユーザーが付箋に書いた依頼に返事を書く書き手です。返事の書き出しにある空欄をユーザーが埋めたので、続きを書いてください。',
    ...noteSections(input),
    section('これまでの返事の書き出し (空欄はユーザーが選んだ値で埋めてある)', input.draft),
    section('ユーザーが選んだ値', bullets(input.filled.map(f => `[[${f.key}]] ${f.label}: ${f.value}`))),
    section('書き方', bullets([
      '書き出しの続きとして、依頼された成果物の中身を具体的に書く。書き出しの内容は繰り返さない',
      '選ばれた値のそれぞれを、内容に反映する',
      '選ばれた値そのものに言及する箇所は、値を書かずに [[key]] と書く。使ってよい key は上の一覧にあるものだけ',
      '見出し (heading) と箇条書き (item) で読みやすくする。quote は例文や引用に使う',
      '全体で日本語500字程度までにする',
      ...COMMON,
    ])),
  ].filter(Boolean).join('\n\n')
}

/* ============ 段階 ============
   POST のパスごとに、入力の検証・プロンプト・スキーマ・出力の検証を引く表 */
const STAGES = {
  '/draft': { name: 'draft', input: noteInput, prompt: draftPrompt, check: checkDraft },
  '/continue': { name: 'continue', input: continueInput, prompt: continuePrompt, check: checkContinuation },
}

/* ============ モデル呼び出し ============ */
function invoke(config, stagePrompt, schema, signal) {
  const { bin, argv, prompt, parse } = HOSTS[config.host]
  // resume は作業ディレクトリのプロジェクトからセッションを探すので、呼び出し元と同じ cwd で起動する
  const child = spawn(bin, argv({ ...config, schema }), { signal, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] })
  const done = new Promise((resolve, reject) => {
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', part => { stdout += part })
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error(`${bin} コマンドが見つかりません`) : error))
    child.on('close', code => {
      let result, failure
      try { result = parse(stdout) } catch (error) { failure = error }
      if (code === 0 && !failure) { resolve(result); return }
      // JSON として読めなかった (SyntaxError) 場合は CLI が落ちただけなので、CLI 側の失敗として伝える
      const told = failure && !(failure instanceof SyntaxError)
      reject(new Error(told ? failure.message : code !== 0 ? `${config.host} が終了コード ${code} で失敗しました` : `${config.host} の出力を読めませんでした`))
    })
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt(stagePrompt, schema))
  return done
}

async function runStage(config, schemas, stage, body, signal) {
  const input = stage.input(body)
  const start = Date.now()
  try {
    const { value, usage, cost_usd } = await invoke(config, stage.prompt(input), schemas[stage.name], signal)
    const result = stage.check(value, input)
    const ms = Date.now() - start
    console.log(JSON.stringify({ stage: stage.name, host: config.host, ms, ...(cost_usd != null && { cost_usd }), usage }))
    return { ...result, host: config.host, ms }
  } catch (error) {
    console.log(JSON.stringify({ stage: stage.name, host: config.host, ms: Date.now() - start, error: error.message }))
    throw error
  }
}

/* ============ サーバー ============ */
async function main() {
  let config
  try { config = resolveConfig(process.argv.slice(2), process.env) } catch (error) { console.error(error.message); process.exit(1) }

  const token = randomBytes(24).toString('hex')
  const page = await readFile(new URL('board.html', import.meta.url))
  const schemas = {}
  for (const { name } of Object.values(STAGES)) {
    const path = fileURLToPath(new URL(`${name}.json`, import.meta.url))
    schemas[name] = { path, json: JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) }
  }

  const server = http.createServer(async (req, res) => {
    const origin = 'http://127.0.0.1:' + server.address().port
    const url = new URL(req.url, origin)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    if (req.headers.host !== new URL(origin).host || url.searchParams.get('t') !== token) {
      res.writeHead(403).end(); return
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page); return
    }
    if (req.method !== 'POST' || req.headers.origin !== origin) {
      res.writeHead(403).end(); return
    }
    const stage = STAGES[url.pathname]
    if (!stage) { res.writeHead(404).end(); return }
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 150000) { res.writeHead(413).end(); return }
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks)) } catch { throw bad('リクエストが JSON ではありません') }
      const result = await runStage(config, schemas, stage, body, AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]))
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
    } catch (error) {
      const message = error.name === 'AbortError' ? '180秒以内に返事が届きませんでした' : error.message
      res.writeHead(error.status ?? 502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }))
    }
  })
  server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port + '/?t=' + token))
}
await main()
