import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CAPS, extract, locateTranscript, modelJson as parseModelJson, prefilteredPrompt, validateInventory } from './inventory.mjs'
import { BASE_URL, ENDPOINT_PATH, LIMITS, judgeRequest, judgeValues } from './judge.mjs'

/* ============ ホスト ============
   呼び出し元のエージェントごとに、CLI の引数の組み立てと標準出力の読み方を1か所に持つ。
   draft / continue / summary は呼び出し元のセッションを fork する。どれも ephemeral なので、セッションの台帳や後片付けは要らない。
   inventory は会話に紐づかない別の呼び出しで、発話だけを渡して軽いモデルに在庫を作らせる (issue #2 の PL)。
   judge (下線の判定) は CLI を使わず、Jev の HTTP API を直接1回呼ぶ (issue #1)。 */
function parseClaude(stdout) {
  const out = JSON.parse(stdout)
  const result = Array.isArray(out) ? out.findLast(e => e.type === 'result') : out
  if (!result || result.is_error) throw new Error(`Claude がエラーを返しました: ${result?.result ?? '応答がありません'}`)
  const u = result.usage ?? {}
  return {
    value: modelJson(result.result),
    cost_usd: result.total_cost_usd,
    usage: { input_tokens: u.input_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, output_tokens: u.output_tokens },
  }
}
// toValue は、agent_message の本文を値にする関数。draft / continue は --output-schema で JSON だけが返るが、inventory はスキーマ無しなのでコードフェンスを許す
function parseCodex(stdout, toValue) {
  const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const message = events.findLast(e => e.type === 'item.completed' && e.item.type === 'agent_message')?.item.text
  if (!message?.trim()) throw new Error('Codex の応答が空です')
  return { value: toValue(message), usage: events.findLast(e => e.type === 'turn.completed')?.usage }
}

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
    parse: parseClaude,
    inventory: {
      model: 'sonnet',
      argv: ({ model }) => ['-p', '--model', model, '--no-session-persistence', '--output-format', 'json', '--tools', '', '--strict-mcp-config'],
      parse: parseClaude,
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
    parse: stdout => parseCodex(stdout, JSON.parse),
    inventory: {
      model: 'gpt-6.2-sol',
      argv: ({ model }) => [
        '-a', 'never', 'exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '-m', model,
        '--ignore-user-config', '--ignore-rules', '-c', 'model_reasoning_effort="low"', '-',
      ],
      parse: stdout => parseCodex(stdout, modelJson),
    },
  },
}

const MODEL_NAME = /^[A-Za-z0-9][\w.:[\]-]{0,63}$/
// 起動時の引数を検証して、以降は検証済みの値だけを使う
function resolveConfig(argv, env) {
  let values
  try { ({ values } = parseArgs({ args: argv, options: { host: { type: 'string' }, session: { type: 'string' } } })) } catch (error) { throw new Error(`引数が不正です: ${error.message.split('\n')[0]}`) }
  const host = values.host ?? (env.CODEX_THREAD_ID ? 'codex' : undefined)
  if (!host || !(host in HOSTS)) throw new Error(`--host に ${Object.keys(HOSTS).join(' か ')} を指定してください (例: node server.mjs --host claude --session <セッションID>)`)
  const session = values.session ?? (host === 'codex' ? env.CODEX_THREAD_ID : undefined)
  // 先頭が - の値は CLI のオプションとして解釈されるので通さない
  if (!session || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(session)) throw new Error('--session に呼び出し元のセッション ID を指定してください')
  const model = env.INTRA_TURN_MODEL || undefined, effort = env.INTRA_TURN_EFFORT || undefined, inventoryModel = env.INTRA_TURN_INVENTORY_MODEL || undefined
  if (model && !MODEL_NAME.test(model)) throw new Error('INTRA_TURN_MODEL の値が不正です')
  if (effort && !/^[a-z]{3,10}$/.test(effort)) throw new Error('INTRA_TURN_EFFORT の値が不正です')
  if (inventoryModel && !MODEL_NAME.test(inventoryModel)) throw new Error('INTRA_TURN_INVENTORY_MODEL の値が不正です')
  return { host, session, model, effort, inventoryModel }
}

// Jev への接続。キーは環境変数 TYPESAFE_API_KEY だけから読み、config にもログにも子プロセスの環境にも入れない。
// INTRA_TURN_JEV_URL (テスト用) は、https か、手元 (127.0.0.1 / localhost) への http だけを通す。キーを平文で外へ出さないため
function resolveJev(env) {
  let base = BASE_URL
  if (env.INTRA_TURN_JEV_URL) {
    let u
    try { u = new URL(env.INTRA_TURN_JEV_URL) } catch { throw new Error('INTRA_TURN_JEV_URL が URL ではありません') }
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('INTRA_TURN_JEV_URL は https の URL にしてください (http は 127.0.0.1 と localhost だけ)')
    base = u.href.replace(/\/+$/, '')
  }
  return { key: env.TYPESAFE_API_KEY || undefined, endpoint: base + ENDPOINT_PATH }
}

/* ============ 入力と出力の検証 ============ */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const bad = message => new HttpError(400, message)
// モデルの出力が形式を外れたとき。ボードには渡さず、画面に出せる文にして返す
const invalid = message => new HttpError(502, `AI の出力が想定の形式ではありませんでした (${message})`)

// コードフェンスや前後の空白を許して、最も外側の JSON オブジェクトを取り出す。形式を外れていたら、ボードに出せる文のエラーにする
function modelJson(text) {
  try { return parseModelJson(text) } catch (error) { throw invalid(error.message) }
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
// ボードの記録。付箋は作られた順で、from は引用元の返事を持つ付箋の番号 (1 から。それより前の付箋)。card は返事が届いたあとの姿
const orNull = (value, name, max) => value == null ? null : text(value, name, max)
function cardInput(card) {
  if (typeof card !== 'object') throw bad('card の形式が不正です')
  return {
    draft: orNull(card.draft, 'draft', 20000),
    filled: list(card.filled, 'filled', 8, f => ({ label: text(f?.label, 'label', 100), value: text(f?.value, 'value', 500) })),
    continuation: orNull(card.continuation, 'continuation', 20000),
    error: orNull(card.error, 'error', 1000),
  }
}
function summaryInput(body) {
  if (!body || typeof body !== 'object') throw bad('リクエストの形式が不正です')
  const notes = list(body.notes, 'notes', 40, (n, i) => {
    if (!n || typeof n !== 'object') throw bad('notes の形式が不正です')
    const from = n.from ?? null
    if (from !== null && !(Number.isInteger(from) && from >= 1 && from <= i)) throw bad('from は、それより前の付箋の番号にしてください')
    return {
      text: text(n.text, 'text', 8000),
      quote: orNull(n.quote, 'quote', 4000),
      from,
      assumptions: list(n.assumptions, 'assumptions', 20, a => text(a, 'assumptions', 300)),
      card: n.card == null ? null : cardInput(n.card),
    }
  })
  if (!notes.length) throw bad('notes は1件以上で指定してください')
  return { notes }
}
// 判定する候補は、付箋の本文にある語だけ。Jev は state.candidates[i] を本文と照らして答えるので、本文に無い語は聞かない
function judgeInput(body) {
  if (!body || typeof body !== 'object') throw bad('リクエストの形式が不正です')
  const note = text(body.text, 'text', LIMITS.text)
  const candidates = list(body.candidates, 'candidates', LIMITS.candidates, c => text(c, 'candidates', LIMITS.text))
  if (!candidates.length) throw bad('candidates は1件以上で指定してください')
  if (new Set(candidates).size !== candidates.length) throw bad('candidates に重複があります')
  if (candidates.some(c => !note.includes(c))) throw bad('candidates は text に含まれる語にしてください')
  return { note, candidates }
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
function checkSummary(value) {
  const title = typeof value?.title === 'string' ? value.title.replace(/\s+/g, ' ').trim() : ''
  if (!title || title.length > 80) throw invalid('title は1〜80文字にしてください')
  if (typeof value.markdown !== 'string' || !value.markdown.trim() || value.markdown.length > 30000) throw invalid('markdown は1〜30000文字にしてください')
  return { title, markdown: value.markdown.trim() }
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

// ボードの記録を、付箋ごとの読み物にする。付箋の番号は、from で引用元を指すためだけに振る
function boardText({ notes }) {
  const part = (label, body) => `${label}\n${body}`
  return notes.map(({ text, quote, from, assumptions, card }, i) => [
    `### 付箋${i + 1}`,
    text,
    quote && part(from ? `付箋${from}の返事から引用している一節` : '引用している一節', quote),
    assumptions.length && part('確認済みの前提', bullets(assumptions)),
    !card && '(まだ送っていない付箋)',
    card?.draft && part('返事の書き出し', card.draft),
    card?.filled.length && part('ユーザーが空欄に選んだ値', bullets(card.filled.map(f => `${f.label}: ${f.value}`))),
    card?.continuation && part('返事の続き', card.continuation),
    card?.error && part('返事を作れなかった理由', card.error),
  ].filter(Boolean).join('\n\n')).join('\n\n')
}
function summaryPrompt(input) {
  return [
    'あなたは、ユーザーがボードで考えたことを、この会話に持ち帰るまとめにする書き手です。これまでの会話の文脈と、下のボードの記録だけを根拠に、ボードでの話し合いをまとめてください。',
    section('ボードの記録 (付箋は作られた順。付箋の本文はユーザーが書き、返事は AI が書いた)', boardText(input)),
    section('書き方', bullets([
      '読み手は、ユーザーと、このあと会話を続ける AI。まとめだけを読んで、続きを進められるようにする',
      'Markdown の見出し (##) で、決まったこと、まだ決まっていないこと、次にやること、付箋ごとの要点の順に書く。書くことが無い節は作らない',
      '決まったことは、確認済みの前提、空欄に選んだ値、付箋に書かれた判断だけから拾う。AI の返事の本文に書かれた案や手順は、ユーザーが選んだものではないので、決まったことに入れない。まだ決まっていないことか次にやることに、AI の提案として書く',
      '返事の書き出しの ［ ］ は、ユーザーがまだ選んでいない空欄で、返事を作れなかった箇所と合わせて、まだ決まっていないことに入れる',
      '次にやることは、具体的な動作で書く',
      '付箋の番号は記録の中の参照用なので書かない。付箋は、書かれた内容で呼ぶ',
      '記録と会話の文脈に無いことは書かない。推測で埋めない',
      '日本語で、全体で1500字程度までにする',
      'title は、ボードで考えたことが分かる短い題 (30字以内)。markdown に title の見出しは含めない',
      'ツールは使わず、ファイルも読まない',
    ])),
  ].join('\n\n')
}

/* ============ まとめの保存 ============
   <呼び出し元の作業ディレクトリ>/intra-turn-board/<日時>-<題>.md に書く。同じ名前があれば番号を足し、上書きしない */
const pad = n => String(n).padStart(2, '0')
// 題から、ファイル名に使える語だけを残す (文字と数字以外は - にするので、/ や .. は残らない)
function summaryName(now, title) {
  const slug = Array.from(title.normalize('NFC').replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-+|-+$/g, '')).slice(0, 40).join('').replace(/-+$/, '') || 'board'
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${slug}`
}
async function saveSummary({ title, markdown }) {
  const dir = join(process.cwd(), 'intra-turn-board'), base = summaryName(new Date(), title)
  try {
    await mkdir(dir, { recursive: true })
    // フォルダ自身に * の .gitignore を置き、呼び出し元のリポジトリの .gitignore は書き換えずに、まとめを git の対象から外す
    try { await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    for (let n = 1; n < 100; n++) {
      const path = join(dir, `${base}${n > 1 ? `-${n}` : ''}.md`)
      // wx は、同じ名前があれば失敗する。確かめてから書くのではなく、書くのと同時に確かめる
      try { await writeFile(path, `# ${title}\n\n${markdown}\n`, { flag: 'wx' }); return { path, title } } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    throw new Error('同じ名前のまとめが多すぎます')
  } catch (error) {
    throw new Error(`まとめを保存できませんでした (${error.message})`)
  }
}

/* ============ 段階 ============
   POST のパスごとに、入力の検証・プロンプト・スキーマ・出力の検証を引く表。save があれば、出力の検証のあとに呼んで、その返り値を応答にする */
const STAGES = {
  '/draft': { name: 'draft', input: noteInput, prompt: draftPrompt, check: checkDraft },
  '/continue': { name: 'continue', input: continueInput, prompt: continuePrompt, check: checkContinuation },
  '/summary': { name: 'summary', input: summaryInput, prompt: summaryPrompt, check: checkSummary, save: saveSummary },
}

/* ============ モデル呼び出し ============ */
function run(host, { argv, cwd, env = process.env, input, parse, signal }) {
  const { bin } = HOSTS[host]
  // 子の claude / codex はツールを使えるので、Jev のキーは渡さない
  const { TYPESAFE_API_KEY, ...childEnv } = env
  const child = spawn(bin, argv, { signal, cwd, env: childEnv, stdio: ['pipe', 'pipe', 'inherit'] })
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
      reject(new Error(told ? failure.message : code !== 0 ? `${host} が終了コード ${code} で失敗しました` : `${host} の出力を読めませんでした`))
    })
  })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  return done
}

function invoke(config, stagePrompt, schema, signal) {
  const { argv, prompt, parse } = HOSTS[config.host]
  // resume は作業ディレクトリのプロジェクトからセッションを探すので、呼び出し元と同じ cwd で起動する
  return run(config.host, { argv: argv({ ...config, schema }), cwd: process.cwd(), input: prompt(stagePrompt, schema), parse, signal })
}

/* ============ 在庫 ============
   起動時に1回だけ、呼び出し元の会話の発話から作る。ボードも draft / continue も待たない。
   状態は pending → ready | empty | failed の一方向で、終わったら変わらない。GET /inventory はこの値をそのまま返す。
   pending の外へ出る道は buildInventory の返り値だけにして、途中の状態を別の変数に持たない。 */
const INVENTORY_TIMEOUT_MS = 300000
// 会話の無いディレクトリで動かす。呼び出し元の cwd だと、CLI がそのプロジェクトの AGENTS.md や CLAUDE.md を読み込み、在庫の指示と混ざる
const NEUTRAL_CWD = join(tmpdir(), 'intra-turn-board')

async function invokeInventory(config, conversation, signal) {
  const { argv, parse, model } = HOSTS[config.host].inventory
  await mkdir(NEUTRAL_CWD, { recursive: true })
  // 子の claude / codex が、呼び出し元の Agent Board (HC_TERMINAL_ID) に自分の作業を書かないようにする
  const { HC_TERMINAL_ID, ...env } = process.env
  return run(config.host, { argv: argv({ model: config.inventoryModel ?? model }), cwd: NEUTRAL_CWD, env, input: prefilteredPrompt(conversation), parse, signal })
}

async function buildInventory(config, signal) {
  const start = Date.now()
  const log = entry => console.log(JSON.stringify({ stage: 'inventory', host: config.host, ms: Date.now() - start, ...entry }))
  try {
    // 会話をまだ始めていないセッションには記録が無いことがあり、それはエラーではない
    const path = await locateTranscript(config.host, config.session)
    const conversation = path ? extract(config.host, await readFile(path, 'utf8')) : ''
    if (!conversation) { log({ empty: path ? '発話がありません' : '会話の記録が見つかりません' }); return { state: 'empty' } }
    const { value, usage, cost_usd } = await invokeInventory(config, conversation, signal)
    const errors = validateInventory(value)
    if (errors.length) throw invalid(errors.slice(0, 3).join(' / '))
    // モデルは上限を超えることがあるので、指示した件数で切る。どちらも重要な順に並べさせている
    const inventory = { open: value.open.slice(0, CAPS.open), facts: value.facts.slice(0, CAPS.facts) }
    log({ ...(cost_usd != null && { cost_usd }), usage, open: value.open.length, facts: value.facts.length })
    return { state: 'ready', inventory, ms: Date.now() - start }
  } catch (error) {
    const message = error.name === 'AbortError' ? `${INVENTORY_TIMEOUT_MS / 1000}秒以内に在庫を作れませんでした` : error.message
    log({ error: message })
    return { state: 'failed', error: message }
  }
}

async function runStage(config, schemas, stage, body, signal) {
  const input = stage.input(body)
  const start = Date.now()
  try {
    const { value, usage, cost_usd } = await invoke(config, stage.prompt(input), schemas[stage.name], signal)
    const checked = stage.check(value, input)
    const saved = stage.save && await stage.save(checked)
    const ms = Date.now() - start
    console.log(JSON.stringify({ stage: stage.name, host: config.host, ms, ...(cost_usd != null && { cost_usd }), usage, ...(saved && { path: saved.path }) }))
    return { ...(saved || checked), host: config.host, ms }
  } catch (error) {
    console.log(JSON.stringify({ stage: stage.name, host: config.host, ms: Date.now() - start, error: error.message }))
    throw error
  }
}

/* ============ 下線の判定 ============
   付箋の候補の語ごとに、書かれていない前提を AI が置く必要があるかを Jev に聞き、0..1 の値で返す。どれを下線にするかはボードが決める。
   1回の呼び出しに全候補を入れ、リトライはしない。入力中に何度も聞くので、遅ければ待たずに諦めて、ボードは規則に戻る。
   キーが無いときは Jev を呼ばず 503 を返す。ボードはそれを見て、そのページでは聞かなくなる (ログは Jev を呼んだときだけ) */
const JUDGE_TIMEOUT_MS = 1500

async function judge(jev, body, signal) {
  if (!jev.key) throw new HttpError(503, 'TYPESAFE_API_KEY がサーバーの環境に無いので、下線の判定は使えません')
  const input = judgeInput(body)
  const start = Date.now()
  const log = entry => console.log(JSON.stringify({ stage: 'judge', ms: Date.now() - start, ...entry }))
  try {
    let res, raw
    try {
      res = await fetch(jev.endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${jev.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(judgeRequest(input.note, input.candidates)), signal,
      })
      raw = await res.text()
    } catch (error) {
      // signal は、ボードが取り消したときと、時間切れ (TimeoutError) のときに止まる。それ以外は接続の失敗
      if (signal.aborted) throw signal.reason?.name === 'TimeoutError' ? new HttpError(502, `Jev が${JUDGE_TIMEOUT_MS / 1000}秒以内に応えませんでした`) : new HttpError(499, 'ボードがリクエストを取り消しました')
      throw new HttpError(502, 'Jev に接続できませんでした')
    }
    if (res.status !== 200) throw new HttpError(502, res.status === 401 || res.status === 403 ? `Jev が認証に失敗しました (HTTP ${res.status})` : `Jev がエラーを返しました (HTTP ${res.status})`)
    let json, values
    try { json = JSON.parse(raw) } catch { throw invalid('Jev の応答が JSON ではありません') }
    try { values = judgeValues(json, input.candidates) } catch (error) { throw invalid(error.message) }
    const ms = Date.now() - start
    log({ ms, ...(typeof json.usage?.input_tokens === 'number' && { input_tokens: json.usage.input_tokens }), n: input.candidates.length })
    return { values, model: typeof json.model === 'string' ? json.model : 'unknown', ms }
  } catch (error) {
    log({ error: error.message })
    throw error
  }
}

/* ============ サーバー ============ */
async function main() {
  let config, jev
  try { config = resolveConfig(process.argv.slice(2), process.env); jev = resolveJev(process.env) } catch (error) { console.error(error.message); process.exit(1) }

  const token = randomBytes(24).toString('hex')
  const page = await readFile(new URL('board.html', import.meta.url))
  const schemas = {}
  for (const { name } of Object.values(STAGES)) {
    const path = fileURLToPath(new URL(`${name}.json`, import.meta.url))
    schemas[name] = { path, json: JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) }
  }

  // POST のパスごとの処理と、待つ時間の上限。draft / continue / summary は呼び出し元のセッションを fork するので長く待つ。judge は短い。
  // maxBytes は本文の上限 (既定 150000)。summary はボード全体の記録を受けるので大きい。after は、応答を送り終えたあとに呼ぶ
  const routes = {
    '/draft': { timeoutMs: 180000, run: (body, signal) => runStage(config, schemas, STAGES['/draft'], body, signal) },
    '/continue': { timeoutMs: 180000, run: (body, signal) => runStage(config, schemas, STAGES['/continue'], body, signal) },
    '/summary': { timeoutMs: 180000, maxBytes: 400000, run: (body, signal) => runStage(config, schemas, STAGES['/summary'], body, signal), after: ({ path }) => finish(path) },
    '/judge': { timeoutMs: JUDGE_TIMEOUT_MS, run: (body, signal) => judge(jev, body, signal) },
  }

  let inventory = { state: 'pending' }
  // 終わるときに、動いている子プロセス (在庫、draft、continue、summary) を止めるための取り消し
  const stopping = new AbortController()

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
    if (req.method === 'GET' && url.pathname === '/inventory') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(inventory)); return
    }
    if (req.method !== 'POST' || req.headers.origin !== origin) {
      res.writeHead(403).end(); return
    }
    const route = routes[url.pathname]
    if (!route) { res.writeHead(404).end(); return }
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > (route.maxBytes ?? 150000)) { res.writeHead(413).end(); return }
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks)) } catch { throw bad('リクエストが JSON ではありません') }
      const result = await route.run(body, AbortSignal.any([controller.signal, stopping.signal, AbortSignal.timeout(route.timeoutMs)]))
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result), () => route.after?.(result))
    } catch (error) {
      const message = error.name === 'AbortError' ? `${route.timeoutMs / 1000}秒以内に返事が届きませんでした` : error.message
      res.writeHead(error.status ?? 502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }))
    }
  })
  // 終了するときは、動いている子プロセス (作りかけの在庫、返事を待つ draft / continue) も止める
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping.abort(); process.kill(process.pid, signal) })

  // まとめを返し終えたら、サーバーも終わる。呼び出し元のエージェントは、`SUMMARY <パス>` の行とプロセスの終了で、まとめができたと知る。
  // 行は書き終えてから終わる (標準出力がパイプだと、すぐ exit すると切れることがある)
  function finish(path) {
    stopping.abort()
    process.stdout.write(`SUMMARY ${path}\n`, () => process.exit(0))
  }

  server.listen(0, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port + '/?t=' + token
    console.log(url)
    if (!process.env.INTRA_TURN_NO_OPEN) openInBrowser(url)
    buildInventory(config, AbortSignal.any([stopping.signal, AbortSignal.timeout(INVENTORY_TIMEOUT_MS)])).then(state => { inventory = state })
  })
}
// 既定のブラウザで開く。開けなくても URL は標準出力に出ているので、失敗は無視する
function openInBrowser(url) {
  const [bin, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  const child = spawn(bin, args, { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

await main()
