#!/usr/bin/env node
/* Jev (TypeSafe System One) で、付箋の候補語に下線を引くべきかを判定できるかを測る。Issue #1 のステップ1。

   envchain typesafe node tools/measure-jev.mjs run     --out DIR [--fixture tools/jev-notes.json] [--repeats 3] [--phases scaling,main,score,ship,reverse[,v2,v3]] [--pause 250] [--resume]
   node tools/measure-jev.mjs analyze --out DIR [--fixture tools/jev-notes.json]      DIR/raw.jsonl から report.json / report.md を書く（キー不要）
   node tools/measure-jev.mjs preview --note birthday [--variant full] [--reverse]    送るリクエストを出力する（送らない）

   基準 B（語と、「の」でつないだ句。tools/jev-notes-b.json、規則は tools/spans.mjs）:
   envchain typesafe node tools/measure-jev.mjs run --fixture tools/jev-notes-b.json --out DIR --phases b,bparts,brev
   node tools/measure-jev.mjs analyze-b --fixture tools/jev-notes-b.json --out DIR    DIR/raw.jsonl から report-b.json / report-b.md を書く（キー不要）
     b      spans 全部に assume + kind、shape を1つ（出荷する形）    bparts  語だけに同じ質問（句が語の値に影響しないかの確認）
     brev   spans を逆順に並べて b と同じ質問（位置の偏りの確認。6件）
   node tools/measure-jev.mjs selftest                                                  純関数とリトライを、偽のサーバーで確かめる（キー不要）

   送るもの   POST https://api.typesafe.ai/v1/systemone  { model: 'jev-latest', state: { note, candidates: [表記] }, questions }
   リクエスト  付箋1件につき1回。variant ごとに質問の組が違う。
     full            候補ごとの impact（noul）、ambiguity（noul）、kind（choice）+ 付箋全体の shape（choice）
     score           候補ごとの impact と ambiguity を score（0..3）で
     ship_impact     出荷する形。impact + kind + shape
     ship_ambiguity  出荷する形。ambiguity + kind + shape
   phase     warmup（1回、集計から除く）/ scaling（質問数と state の長さを振る）/ main（full）/ score / ship / reverse（候補を逆順にして位置の偏りを見る）
             v2（v1 の結果を見て聞き直した質問。事後）/ v3（依頼の中心かを聞く質問。事後。ラベルは tools/jev-notes-central.json）
   遅延は、クライアントで fetch を始めてから本文を読み終えるまでの時計時間。逐次に送り、並列にはしない。リトライは 429 / 5xx / 通信エラーだけ。
   キーは環境変数 TYPESAFE_API_KEY だけから読み、ログにも出力にも書かない。

   判定の規則は tools/jev-notes.json の protocol に、run の前に決めて書いてある。 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { loadavg } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { selectSpans, mergeWins, chainsOf, overlaps, within, mergeSpans, MARGINS } from './spans.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const MODEL = 'jev-latest'
export const USD_PER_M_INPUT = 0.042
export const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
export const SCORE_LEVELS = 4
export const CAP = 3

/* ============ 質問の組み立て（純関数） ============ */
const FRAME = '`state.note` は、ユーザーが AI に頼む内容を書いた付箋です。'
const target = (i, s) => `\`state.candidates[${i}]\`（「${s}」）`
const only = i => `\`state.candidates[${i}]\` だけを判断し、他の候補のことは考えないでください。`

export const KINDS = {
  '人数': '人数、人の数、規模。何人かを決める問い。',
  '日時・期間': 'いつ、いつまで、どれくらいの長さか。',
  '場所': 'どこで、どこへ、どの地域か。',
  '対象・読者': '誰に向けるか、誰のためか、相手との関係、対象の範囲。',
  '好み・テーマ': '好み、題材、分野、方向性。何についてか。',
  '見た目・調子': '色や形などの見た目、文章の調子、雰囲気、丁寧さ。',
  '形式・量': '形式、数、長さ、詳しさ、出力の体裁。',
  'その他': '上のどれにも当てはまらない。',
}
export const SHAPES = {
  '短い提案': '少数の案や短い答えが欲しい。',
  '詳しい手順': '手順や計画を、順を追って詳しく書いたものが欲しい。',
  '選択肢の比較': '複数の案や選択肢を並べて、比べたものが欲しい。',
  '文章そのもの': 'メールや原稿のように、そのまま使える文章が欲しい。',
}
const IMPACT_TEXT = i => 'この語についてユーザーに確かめず、AI が自分で決めて進めたとします。AI が返す成果物（提案・文章・計画・コードなど）は、決め方しだいで大きく変わりますか。'
const AMBIGUITY_TEXT = i => 'この付箋の文脈で、この語が指す内容や条件は、書き手によって割れますか。つまり、付箋の文面だけでは一つに決まらず、書き手ごとに答えが違いそうですか。'

export function makeQuestion(name, i, s) {
  const head = `${FRAME}${target(i, s)}は、その付箋にある語です。`
  switch (name) {
    case 'impact': return {
      type: 'noul', instructions: `${head}${IMPACT_TEXT(i)}${only(i)}`,
      criteria: { true: 'この語の扱いを AI が黙って決めると、成果物の中身や方向が大きく変わる。決め方しだいで別のものになる。', false: 'AI が自分で決めても、成果物はほとんど変わらない。付箋の文面で扱いがほぼ決まっている、または依頼の背景や言い回しにすぎない。' },
    }
    case 'ambiguity': return {
      type: 'noul', instructions: `${head}${AMBIGUITY_TEXT(i)}${only(i)}`,
      criteria: { true: '文面だけでは意味・範囲・条件が一つに決まらず、書き手ごとに違う中身を指し得る。', false: '文面から意味や条件がほぼ一つに決まる。誰が書いても同じ内容を指す。' },
    }
    case 'kind': return {
      type: 'choice', instructions: `${head}この語について、AI がユーザーに確かめるとしたら、何を決める問いになりますか。最も近い種類を選んでください。${only(i)}`,
      criteria: KINDS,
    }
    case 'impactScore': return {
      type: 'score', instructions: `${head}${IMPACT_TEXT(i)}変わる度合いを選んでください。${only(i)}`,
      criteria: ['AI が決めても成果物はほぼ変わらない。', '少し変わるが、方向は同じ。', '大きく変わる。', '決め方しだいで、全く別の成果物になる。'],
    }
    case 'ambiguityScore': return {
      type: 'score', instructions: `${head}${AMBIGUITY_TEXT(i)}割れる度合いを選んでください。${only(i)}`,
      criteria: ['文面から意味が一つに決まる。', '少し幅があるが、ほぼ同じ内容を指す。', '書き手によってかなり違う内容を指す。', '書き手ごとに全く違い、文面からは見当がつかない。'],
    }
    /* v2: v1 の結果を見たあとで、「語そのものを AI が決める」ではなく「付箋に書かれていない前提を置く」と聞き直したもの。v1 より楽観的な数字になる（同じ付箋で直したため） */
    case 'impact2': return {
      type: 'noul', instructions: `${head}AI がこの依頼に応えるには、この語について、付箋に書かれていない前提（好み・人数・日時・対象・調子・長さ・範囲など）を置く必要がありますか。その置き方しだいで、成果物は大きく変わりますか。${only(i)}`,
      criteria: { true: '付箋に書かれていない前提を AI が置く必要があり、置き方しだいで成果物が大きく変わる。例えば「商品説明文」なら対象読者や文体、「弁当」なら人数や予算。', false: '付箋に書かれた内容だけで足りる。または、前提をどう置いても成果物はほとんど変わらない。例えば、人名や地名のように指す先が一つに決まっている語、依頼の前置き。' },
    }
    case 'ambiguity2': return {
      type: 'noul', instructions: `${head}この語について、付箋に書かれていない条件が幾通りもあり、書き手ごとに選ぶ答えが違いそうですか。${only(i)}`,
      criteria: { true: '付箋に書かれていない条件が幾通りもあり、書き手ごとに選ぶ答えが違う。', false: '付箋の文面で条件が決まっている。または、誰が書いても同じ答えになる。' },
    }
    case 'object': return {
      type: 'noul', instructions: `${head}AI がこの語について、付箋に書かれていない前提を黙って置いて進めたとします。付箋の書き手は「そこは違う、先に聞いてほしかった」と思いそうですか。${only(i)}`,
      criteria: { true: '書き手は「そこは違う、先に聞いてほしかった」と思いそう。', false: '書き手は気にしない。または、付箋の文面で決まっていて、AI が置く前提がない。' },
    }
    /* v3: 依頼の中心（成果物そのもの）かどうか。第3の基準の候補。事後の診断で足した */
    case 'central': return {
      type: 'noul', instructions: `${head}この語は、ユーザーが AI に作ってほしい、または決めてほしいもの（成果物そのもの、またはその主要な部分）ですか。依頼の背景や条件、前置きにすぎない語ではありませんか。${only(i)}`,
      criteria: { true: 'ユーザーが AI に求めている成果物そのもの、またはその主要な部分である。', false: '依頼の背景、条件、対象、前置きなどで、成果物ではない。' },
    }
    /* B: ユーザーが決めた基準（Issue #1 の最新のコメント以降）。語にも「の」でつないだ句にも、同じ文言を送る。
       impact2 と違い、false の例に地名を挙げない（「日本 → 地域」と合わないため）。例の語は ASSUME_EXAMPLES で、どの付箋にも含めない（selftest） */
    case 'assume': return {
      type: 'noul', instructions: `${FRAME}${target(i, s)}は、その付箋にある語、または「の」でつながった語の句です。AI がこの依頼に応えるには、これについて、付箋に書かれていない属性や条件（人数・年齢・地域・日時・予算・対象・調子・長さ・形式・ジャンルなど）を置く必要がありますか。その置き方しだいで、成果物は大きく変わりますか。${only(i)}`,
      criteria: { true: '付箋に書かれていない属性や条件を AI が置かないと進められず、置き方しだいで成果物が大きく変わる。例えば「海外」なら国や地域、「弁当」なら人数や予算、「論文」なら分量や読み手。', false: '必要な属性や条件が付箋の文面にすでに書かれている。または、どう置いても成果物はほとんど変わらない。例えば「30分」のように値が書かれている語、「お願いします」のような依頼の言い回し。' },
    }
    default: throw new Error(`unknown question ${name}`)
  }
}
export const ASSUME_EXAMPLES = ['海外', '弁当', '論文', '30分', 'お願いします']
export function shapeQuestion() {
  return {
    type: 'choice',
    instructions: `${FRAME}この付箋は、AI に何を返してほしいのですか。最も近いものを選んでください。\`state.candidates\` は考えず、\`state.note\` 全体から判断してください。`,
    criteria: SHAPES,
  }
}

export const VARIANTS = {
  full: ['impact', 'ambiguity', 'kind', 'shape'],
  score: ['impactScore', 'ambiguityScore'],
  ship_impact: ['impact', 'kind', 'shape'],
  ship_ambiguity: ['ambiguity', 'kind', 'shape'],
  v2: ['impact2', 'ambiguity2', 'object'],
  v3: ['central'],
  /* 基準 B（assume）。spans は語と句を全部送る（出荷する形）。parts は語だけ（句を足しても語の値が動かないかの確認） */
  spans: ['assume', 'kind', 'shape'],
  parts: ['assume', 'kind', 'shape'],
}
const PHASE_OF = { full: 'main', score: 'score', v2: 'v2', v3: 'v3' }

/* variant が spans のとき、候補は note.spans（語と句）。それ以外は note.candidates（語だけ） */
export function buildRequest(note, variant, { reverse = false, context = '', names = VARIANTS[variant] } = {}) {
  const surfaces = (variant === 'spans' ? note.spans : note.candidates).map(c => c.surface)
  if (reverse) surfaces.reverse()
  const state = { note: note.text, candidates: surfaces }
  if (context) state.context = context
  const questions = {}
  for (const name of names) {
    if (name === 'shape') questions.shape = shapeQuestion()
    else surfaces.forEach((s, i) => { questions[`${name}_${i}`] = makeQuestion(name, i, s) })
  }
  return { body: { model: MODEL, state, questions }, surfaces }
}

/* 質問数だけを振る。state は固定で、k 個の impact を候補に巡回して聞く */
export function buildScalingQuestions(note, k, context = '') {
  const surfaces = note.candidates.map(c => c.surface)
  const questions = {}
  for (let n = 0; n < k; n++) questions[`impact_${n}`] = makeQuestion('impact', n % surfaces.length, surfaces[n % surfaces.length])
  const state = { note: note.text, candidates: surfaces }
  if (context) state.context = context
  return { body: { model: MODEL, state, questions }, surfaces }
}

/* ============ HTTP ============ */
const sleepMs = ms => new Promise(r => setTimeout(r, ms))
export async function post(body, { endpoint = ENDPOINT, key, timeoutMs = 60_000, maxTries = 4, sleep = sleepMs } = {}) {
  const payload = JSON.stringify(body)
  const requestBytes = Buffer.byteLength(payload)
  const retries = []
  const wall0 = performance.now()
  for (let attempt = 1; ; attempt++) {
    const t0 = performance.now()
    let status = 0, text = '', error = null, retryAfter = null
    try {
      const res = await fetch(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: payload, signal: AbortSignal.timeout(timeoutMs),
      })
      status = res.status; retryAfter = res.headers.get('retry-after'); text = await res.text()
    } catch (e) { error = e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.code ?? e.message) }
    const latencyMs = performance.now() - t0
    if (status === 200) {
      try { return { ok: true, status, latencyMs, wallMs: performance.now() - wall0, tries: attempt, retries, requestBytes, json: JSON.parse(text) } }
      catch { error = 'invalid JSON body' }
    }
    const retryable = error !== null && status === 0 || status === 429 || status >= 500
    if (!retryable || attempt >= maxTries) return { ok: false, status, error: error ?? text.slice(0, 500), latencyMs, wallMs: performance.now() - wall0, tries: attempt, retries, requestBytes }
    const waitMs = retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : 1000 * 2 ** (attempt - 1) + Math.random() * 250
    retries.push({ status, error, waitMs: Math.round(waitMs), afterMs: Math.round(latencyMs) })
    await sleep(waitMs)
  }
}

/* ============ 計画と実行 ============ */
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
/* ラベルと問いの文言を Jev に送る前に固めたことの証拠。fixture の protocol にある値と、run のたびに照合する */
export const labelsHash = fx => createHash('sha256').update(JSON.stringify(fx.notes.map(n => [n.id, n.set, n.text, n.underline, n.unsure]))).digest('hex')
export const questionHash = () => createHash('sha256').update(JSON.stringify(makeQuestion('assume', 0, '{表記}'))).digest('hex')
const loadFixture = path => JSON.parse(readFileSync(path, 'utf8'))
const noteById = (fx, id) => { const n = fx.notes.find(x => x.id === id); if (!n) throw new Error(`付箋 ${id} が無い`); return n }
const REVERSE_NOTES = ['birthday', 'study-talk', 'offsite']
const REVERSE_B_NOTES = ['birthday', 'study-talk', 'offsite', 'cafe-open', 'training-redo', 'launch']
const SCALING_K = [1, 2, 4, 8, 16, 32, 48, 64]
const SCALING_CHARS = [0, 1000, 4000, 16000]

function filler(fx, chars) {
  let s = ''
  for (let i = 0; s.length < chars; i++) s += fx.notes[i % fx.notes.length].text
  return s.slice(0, chars)
}

export function buildPlan(fx, { repeats = 3, phases = ['scaling', 'main', 'score', 'ship', 'reverse'] } = {}) {
  const jobs = []
  const add = (phase, variant, note, repeat, req, extra = '') =>
    jobs.push({ id: `${phase}|${variant}|${note.id}|${extra}|r${repeat}`, phase, variant, noteId: note.id, repeat, extra, ...req })
  const first = fx.notes[0], bd = noteById(fx, 'birthday')
  const warmVariant = phases.includes('b') ? 'spans' : 'ship_impact'
  add('warmup', warmVariant, first, 0, buildRequest(first, warmVariant))
  if (phases.includes('scaling')) {
    for (let r = 1; r <= repeats; r++) {
      for (const k of SCALING_K) add('scaling-questions', `q${k}`, bd, r, buildScalingQuestions(bd, k))
      for (const chars of SCALING_CHARS) add('scaling-state', `s${chars}`, bd, r, buildScalingQuestions(bd, 4, filler(fx, chars)))
    }
  }
  const rounds = (phase, variant, notes, opts = {}) => {
    for (let r = 1; r <= repeats; r++) for (const n of notes) add(phase, variant, n, r, buildRequest(n, variant, opts), opts.reverse ? 'reverse' : '')
  }
  if (phases.includes('main')) rounds('main', 'full', fx.notes)
  if (phases.includes('score')) rounds('score', 'score', fx.notes)
  if (phases.includes('ship')) { rounds('ship', 'ship_impact', fx.notes); rounds('ship', 'ship_ambiguity', fx.notes) }
  if (phases.includes('v2')) rounds('v2', 'v2', fx.notes)
  if (phases.includes('v3')) rounds('v3', 'v3', fx.notes)
  if (phases.includes('reverse')) rounds('reverse', 'full', REVERSE_NOTES.map(id => noteById(fx, id)), { reverse: true })
  if (phases.includes('b')) rounds('b', 'spans', fx.notes)
  if (phases.includes('bparts')) rounds('bparts', 'parts', fx.notes)
  if (phases.includes('brev')) rounds('brev', 'spans', REVERSE_B_NOTES.map(id => noteById(fx, id)), { reverse: true })
  return jobs
}

async function runCommand(opt) {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) throw new Error('TYPESAFE_API_KEY が無い。envchain typesafe node tools/measure-jev.mjs run ... で起動する')
  const fxPath = resolve(opt.fixture)
  const fx = loadFixture(fxPath)
  const out = resolve(opt.out)
  mkdirSync(out, { recursive: true })
  const rawPath = join(out, 'raw.jsonl')
  const repeats = Number(opt.repeats), pause = Number(opt.pause)
  const phases = opt.phases.split(',')
  const labelsSha256 = labelsHash(fx), questionSha256 = questionHash()
  if (fx.protocol?.labelsSha256 && fx.protocol.labelsSha256 !== labelsSha256) throw new Error('ラベルが protocol.labelsSha256 と違う。Jev を呼ぶ前に固めたラベルを変えてはいけない')
  if (fx.protocol?.questionSha256 && fx.protocol.questionSha256 !== questionSha256) throw new Error('B の問いの文言が protocol.questionSha256 と違う')
  if (phases.some(p => ['b', 'bparts', 'brev'].includes(p)) && fx.notes.some(n => !n.spans)) throw new Error('spans が無い付箋がある。tools/extract-jev-candidates.mjs を先に実行する')
  const done = new Set()
  if (opt.resume && existsSync(rawPath)) for (const l of readFileSync(rawPath, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); if (r.status === 200) done.add(r.id) }
  else if (existsSync(rawPath)) throw new Error(`${rawPath} が既にある。--resume で続けるか、別の --out にする`)
  const metaPath = join(out, 'meta.json')
  const meta = {
    startedAt: new Date().toISOString(), node: process.version, platform: process.platform, loadavgAtStart: loadavg(),
    fixtureSha256: sha256(fxPath), labelsSha256, questionSha256, endpoint: opt.endpoint, modelRequested: MODEL, repeats, pauseMs: pause, phases,
  }
  if (opt.resume && existsSync(metaPath)) {
    const prev = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (prev.fixtureSha256 !== meta.fixtureSha256) throw new Error('fixture が最初の run と違う。--resume できない')
    writeFileSync(metaPath, JSON.stringify({ ...prev, resumes: [...(prev.resumes ?? []), { at: meta.startedAt, loadavg: meta.loadavgAtStart }] }, null, 2))
  } else writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  const jobs = buildPlan(fx, { repeats, phases })
  console.error(`${jobs.length} requests (${done.size} done)`)
  let consecutiveFailures = 0
  for (const [n, job] of jobs.entries()) {
    if (done.has(job.id)) continue
    const res = await post(job.body, { endpoint: opt.endpoint, key })
    const rec = {
      id: job.id, phase: job.phase, variant: job.variant, noteId: job.noteId, repeat: job.repeat, extra: job.extra,
      candidates: job.surfaces, questions: Object.keys(job.body.questions).length, requestBytes: res.requestBytes,
      at: new Date().toISOString(), status: res.status, ok: res.ok, latencyMs: Math.round(res.latencyMs * 10) / 10,
      wallMs: Math.round(res.wallMs), tries: res.tries, retries: res.retries,
    }
    if (res.ok) Object.assign(rec, { model: res.json.model, usage: res.json.usage, answers: res.json.answers })
    else rec.error = res.error
    appendFileSync(rawPath, JSON.stringify(rec) + '\n')
    console.error(`[${n + 1}/${jobs.length}] ${job.id} ${res.ok ? `${rec.latencyMs} ms, ${res.json.usage?.input_tokens} tok` : `FAILED ${res.status} ${res.error}`}${res.retries.length ? ` (retries ${res.retries.length})` : ''}`)
    if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}。キーか権限を確かめる（キーは表示しない）`)
    consecutiveFailures = res.ok ? 0 : consecutiveFailures + 1
    if (consecutiveFailures >= 5) throw new Error('5回続けて失敗したので止める')
    await sleepMs(pause)
  }
}

/* ============ 集計の部品（純関数） ============ */
export const round6 = x => Math.round(x * 1e6) / 1e6
export const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
export const sd = xs => xs.length < 2 ? 0 : Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1))
export function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b), pos = (s.length - 1) * q, lo = Math.floor(pos)
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo)
}
export const summary = xs => xs.length ? { n: xs.length, min: Math.min(...xs), p50: quantile(xs, 0.5), mean: mean(xs), p95: quantile(xs, 0.95), max: Math.max(...xs) } : { n: 0 }
export function ols(xs, ys) {
  const mx = mean(xs), my = mean(ys)
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0), syy = ys.reduce((a, y) => a + (y - my) ** 2, 0)
  const slope = sxx ? sxy / sxx : 0
  return { slope, intercept: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 }
}

/* mode: negative（unsure は付けない側）/ positive（unsure も付ける側）/ drop（unsure は数えない）/ central（事後の診断ラベル。別ファイル） */
function labelSets(note, mode) {
  if (mode === 'central') return { pos: new Set(note.central ?? []), ignore: new Set() }
  const u = new Set(note.underline), s = new Set(note.unsure)
  return { pos: mode === 'positive' ? new Set([...u, ...s]) : u, ignore: mode === 'drop' ? s : new Set() }
}

/* values は note.candidates と同じ並び。同点は出現順（添字の小さい方）を先にする */
export function order(values) {
  return values.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(x => x[1])
}
export function pick(note, values, rule) {
  const surf = note.candidates.map(c => c.surface)
  const idx = order(values)
  const ok = t => idx.filter(i => values[i] >= t - 1e-9)
  let chosen
  if (rule.type === 'top') chosen = idx.slice(0, rule.n ?? CAP)
  else if (rule.type === 'threshold') chosen = ok(rule.t)
  else if (rule.type === 'capped') chosen = ok(rule.t).slice(0, CAP)
  else if (rule.type === 'first') chosen = surf.map((_, i) => i).slice(0, CAP)
  else throw new Error(`unknown rule ${rule.type}`)
  return new Set(chosen.map(i => surf[i]))
}

export function prf(tp, fp, fn) {
  const precision = tp + fp ? tp / (tp + fp) : null, recall = tp + fn ? tp / (tp + fn) : null
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : 0
  return { tp, fp, fn, precision, recall, f1 }
}
export function tally(items, chooser, mode = 'negative') {
  let tp = 0, fp = 0, fn = 0
  for (const it of items) {
    const { pos, ignore } = labelSets(it.note, mode), sel = chooser(it)
    for (const s of sel) { if (pos.has(s)) tp++; else if (!ignore.has(s)) fp++ }
    for (const s of pos) if (!sel.has(s)) fn++
  }
  return prf(tp, fp, fn)
}
export function auc(items, mode = 'negative') {
  const P = [], N = []
  for (const { note, v } of items) {
    const { pos, ignore } = labelSets(note, mode)
    note.candidates.forEach((c, i) => { if (!ignore.has(c.surface)) (pos.has(c.surface) ? P : N).push(v[i]) })
  }
  if (!P.length || !N.length) return null
  let s = 0
  for (const p of P) for (const n of N) s += p > n ? 1 : p === n ? 0.5 : 0
  return s / (P.length * N.length)
}
export function withinNoteAuc(items, mode = 'negative') {
  const xs = items.map(it => auc([it], mode)).filter(x => x !== null)
  return xs.length ? { mean: mean(xs), n: xs.length } : null
}
export function top1Hit(items, mode = 'negative') {
  let hit = 0, n = 0
  for (const { note, v } of items) {
    const { pos } = labelSets(note, mode)
    if (!pos.size) continue
    n++
    if (pos.has(note.candidates[order(v)[0]].surface)) hit++
  }
  return { hit, n }
}
/* 規則に従って閾値を選ぶ: 上限3つの規則の F1 が最大。0.02 以内で並ぶなら適合率が高い方、さらに並ぶなら閾値が高い方 */
export function bestThreshold(items, mode = 'negative') {
  const rows = THRESHOLDS.map(t => ({ t, ...tally(items, it => pick(it.note, it.v, { type: 'capped', t }), mode) }))
  const top = Math.max(...rows.map(r => r.f1))
  const near = rows.filter(r => r.f1 >= top - 0.02)
  near.sort((a, b) => (b.precision ?? 0) - (a.precision ?? 0) || b.t - a.t)
  return near[0].t
}
function mulberry32(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/* 付箋を再標本化して、指標 fn(items) の分布の95%区間を返す */
export function bootstrap(items, fn, B = 2000, seed = 1) {
  const rnd = mulberry32(seed), xs = []
  for (let b = 0; b < B; b++) {
    const sample = Array.from({ length: items.length }, () => items[Math.floor(rnd() * items.length)])
    const x = fn(sample)
    if (x !== null && Number.isFinite(x)) xs.push(x)
  }
  return { lo: quantile(xs, 0.025), hi: quantile(xs, 0.975), n: xs.length }
}

/* ============ 生データから表を作る ============ */
const readJsonl = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const groupBy = (xs, f) => { const m = new Map(); for (const x of xs) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x) } return m }

/* 付箋 id -> repeat 順の配列 -> fixture の候補順の値。記録の候補順（逆順の実験を含む）から表記で引き直す */
export function valueRows(fx, records, variant, name, norm = v => v) {
  const out = new Map()
  for (const rec of records.filter(r => r.ok && r.phase === PHASE_OF[variant] && r.variant === variant && !r.extra)) {
    const note = noteById(fx, rec.noteId)
    const byKey = Object.fromEntries(rec.candidates.map((s, i) => [s, rec.answers[`${name}_${i}`]]))
    const row = note.candidates.map(c => {
      const a = byKey[c.surface]
      return norm(a.type === 'noul' ? a.noul : a.score)
    })
    if (!out.has(note.id)) out.set(note.id, [])
    out.get(note.id).push({ repeat: rec.repeat, v: row })
  }
  for (const rows of out.values()) rows.sort((a, b) => a.repeat - b.repeat)
  return out
}
export const itemsFrom = (fx, rows, repeat = null) => fx.notes.filter(n => rows.has(n.id)).map(note => {
  const reps = rows.get(note.id)
  const sel = repeat === null ? reps : reps.filter(r => r.repeat === repeat)
  return { note, v: note.candidates.map((_, i) => round6(mean(sel.map(r => r.v[i])))) }
}).filter(it => it.v.every(Number.isFinite))

function combine(a, b, f) {
  const out = new Map()
  for (const [id, ra] of a) {
    const rb = b.get(id); if (!rb) continue
    out.set(id, ra.map(x => ({ repeat: x.repeat, v: x.v.map((_, i) => { const y = rb.find(r => r.repeat === x.repeat); return y ? f(x.v[i], y.v[i]) : NaN }) })))
  }
  return out
}

function evaluate(fx, rows, label) {
  const items = itemsFrom(fx, rows)
  const res = { label, notes: items.length }
  res.auc = { negative: auc(items), positive: auc(items, 'positive'), drop: auc(items, 'drop') }
  res.withinNoteAuc = withinNoteAuc(items)
  res.top1 = top1Hit(items)
  res.top3 = Object.fromEntries(['negative', 'positive', 'drop'].map(m => [m, tally(items, it => pick(it.note, it.v, { type: 'top' }), m)]))
  res.threshold = THRESHOLDS.map(t => ({
    t,
    uncapped: tally(items, it => pick(it.note, it.v, { type: 'threshold', t })),
    capped: tally(items, it => pick(it.note, it.v, { type: 'capped', t })),
    cappedDrop: tally(items, it => pick(it.note, it.v, { type: 'capped', t }), 'drop'),
    cappedPositive: tally(items, it => pick(it.note, it.v, { type: 'capped', t }), 'positive'),
  }))
  res.bestT = bestThreshold(items)
  res.bestTByMode = { positive: bestThreshold(items, 'positive'), drop: bestThreshold(items, 'drop') }
  const reps = [...new Set([...rows.values()].flatMap(r => r.map(x => x.repeat)))].sort()
  res.perRepeat = reps.map(r => {
    const it = itemsFrom(fx, rows, r)
    return { repeat: r, auc: auc(it), top3F1: tally(it, x => pick(x.note, x.v, { type: 'top' })).f1, cappedF1: tally(it, x => pick(x.note, x.v, { type: 'capped', t: res.bestT })).f1 }
  })
  return res
}

function stabilityOf(fx, rows, label) {
  const ranges = [], sds = []
  for (const reps of rows.values()) {
    if (reps.length < 2) continue
    reps[0].v.forEach((_, i) => { const xs = reps.map(r => r.v[i]); ranges.push(Math.max(...xs) - Math.min(...xs)); sds.push(sd(xs)) })
  }
  const topChanged = [], tieAtBoundary = []
  for (const note of fx.notes) {
    const reps = rows.get(note.id)
    if (!reps || reps.length < 2 || note.candidates.length <= CAP) continue
    const sets = reps.map(r => [...pick(note, r.v, { type: 'top' })].sort().join('|'))
    topChanged.push(new Set(sets).size > 1)
    for (const r of reps) { const o = order(r.v); tieAtBoundary.push(r.v[o[CAP - 1]] === r.v[o[CAP]]) }
  }
  const rr = summary(ranges)
  return {
    label, questions: ranges.length, repeats: [...rows.values()][0]?.length ?? 0,
    range: { ...rr, p95: ranges.length ? quantile(ranges, 0.95) : null, zero: ranges.filter(x => x === 0).length, ge010: ranges.filter(x => x >= 0.1 - 1e-9).length, ge020: ranges.filter(x => x >= 0.2 - 1e-9).length },
    sd: { mean: sds.length ? mean(sds) : null, p50: sds.length ? quantile(sds, 0.5) : null, max: sds.length ? Math.max(...sds) : null },
    top3Changed: { changed: topChanged.filter(Boolean).length, notes: topChanged.length },
    tieAtBoundary: { ties: tieAtBoundary.filter(Boolean).length, of: tieAtBoundary.length },
  }
}

function modal(xs) {
  const c = new Map(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1)
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]
}

function kindShape(fx, records) {
  const full = records.filter(r => r.ok && r.phase === 'main' && r.variant === 'full')
  const kinds = [], shapes = []
  for (const note of fx.notes) {
    const recs = full.filter(r => r.noteId === note.id)
    if (!recs.length) continue
    note.candidates.forEach((c, i) => {
      const answers = recs.map(r => r.answers[`kind_${r.candidates.indexOf(c.surface)}`])
      const [choice, votes] = modal(answers.map(a => a.choice))
      const label = note.underline.includes(c.surface) ? 'underline' : note.unsure.includes(c.surface) ? 'unsure' : 'none'
      kinds.push({ noteId: note.id, surface: c.surface, label, choice, votes, of: answers.length, confidence: mean(answers.filter(a => a.choice === choice).map(a => a.confidence)), probabilities: answers[0].probabilities })
    })
    const sa = recs.map(r => r.answers.shape), [choice, votes] = modal(sa.map(a => a.choice))
    shapes.push({ noteId: note.id, choice, votes, of: sa.length, confidence: mean(sa.filter(a => a.choice === choice).map(a => a.confidence)) })
  }
  const dist = rows => Object.fromEntries([...groupBy(rows, r => r.choice)].map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1]))
  return {
    kinds, shapes,
    kindDist: dist(kinds), kindDistUnderlined: dist(kinds.filter(k => k.label === 'underline')), shapeDist: dist(shapes),
    kindAgree: { all: kinds.filter(k => k.votes === k.of).length, of: kinds.length },
    kindConfidence: summary(kinds.map(k => k.confidence)), shapeConfidence: summary(shapes.map(s => s.confidence)),
    shapeAgree: { all: shapes.filter(s => s.votes === s.of).length, of: shapes.length },
  }
}

function latencyReport(records) {
  const ok = records.filter(r => r.ok && r.phase !== 'warmup')
  const by = (phase, variant) => ok.filter(r => r.phase === phase && (variant ? r.variant === variant : true))
  const lat = rs => rs.map(r => r.latencyMs)
  const group = (name, rs) => ({ name, ...summary(lat(rs)), over1000: lat(rs).filter(x => x > 1000).length, over1500: lat(rs).filter(x => x > 1500).length, questions: rs.length ? summary(rs.map(r => r.questions)) : null, inputTokens: rs.length ? summary(rs.map(r => r.usage.input_tokens)) : null, outputTokens: rs.length ? summary(rs.map(r => r.usage.output_tokens)) : null })
  const groups = [
    group('main (full)', by('main')), group('score', by('score')), group('ship_impact', by('ship', 'ship_impact')), group('ship_ambiguity', by('ship', 'ship_ambiguity')), group('reverse (full)', by('reverse')), group('v2', by('v2')), group('v3 (central のみ)', by('v3')),
  ].filter(g => g.n)
  const rounds = [1, 2, 3].map(r => ({ repeat: r, ...summary(lat(by('main').filter(x => x.repeat === r))) })).filter(r => r.n)
  const warm = records.filter(r => r.ok && r.phase === 'warmup').map(r => r.latencyMs)
  const scaling = (phase, key) => [...groupBy(ok.filter(r => r.phase === phase), r => r.variant)].map(([variant, rs]) => ({
    variant, ...summary(lat(rs)), questions: rs[0].questions, inputTokens: mean(rs.map(r => r.usage.input_tokens)), outputTokens: mean(rs.map(r => r.usage.output_tokens)), requestBytes: rs[0].requestBytes,
  }))
  const pool = ok.filter(r => ['main', 'score', 'ship', 'reverse'].includes(r.phase))
  const reg = (rs, f) => rs.length > 2 ? ols(rs.map(f), lat(rs)) : null
  const qs = ok.filter(r => r.phase === 'scaling-questions'), ss = ok.filter(r => r.phase === 'scaling-state')
  const regression = {
    pooledNotes: { n: pool.length, questions: reg(pool, r => r.questions), inputTokens: reg(pool, r => r.usage.input_tokens), outputTokens: reg(pool, r => r.usage.output_tokens), requestBytes: reg(pool, r => r.requestBytes) },
    scalingQuestions: { n: qs.length, questions: reg(qs, r => r.questions), inputTokens: reg(qs, r => r.usage.input_tokens), outputTokens: reg(qs, r => r.usage.output_tokens) },
    scalingState: { n: ss.length, inputTokens: reg(ss, r => r.usage.input_tokens) },
  }
  const failed = records.filter(r => !r.ok)
  return {
    groups, rounds, warmupMs: warm, scalingQuestions: scaling('scaling-questions'), scalingState: scaling('scaling-state'), regression,
    failures: failed.map(r => ({ id: r.id, status: r.status, error: r.error, tries: r.tries })),
    retried: records.filter(r => r.retries?.length).map(r => ({ id: r.id, ok: r.ok, retries: r.retries })),
  }
}

function costReport(records) {
  const rs = records.filter(r => r.ok), usd = t => (t * USD_PER_M_INPUT) / 1e6
  const phases = [...groupBy(rs, r => `${r.phase}${r.phase === 'ship' ? ':' + r.variant : ''}`)].map(([phase, xs]) => ({ phase, requests: xs.length, inputTokens: xs.reduce((a, r) => a + r.usage.input_tokens, 0), outputTokens: xs.reduce((a, r) => a + r.usage.output_tokens, 0) }))
  for (const p of phases) p.usd = usd(p.inputTokens)
  const total = phases.reduce((a, p) => a + p.inputTokens, 0)
  const ship = rs.filter(r => r.phase === 'ship')
  return { phases, totalRequests: rs.length, totalInputTokens: total, totalUsd: usd(total), models: [...new Set(rs.map(r => r.model))], perShipRequestUsd: ship.length ? usd(mean(ship.map(r => r.usage.input_tokens))) : null, perShipRequestTokens: ship.length ? mean(ship.map(r => r.usage.input_tokens)) : null }
}

function consistency(fx, records) {
  const meanAbs = (a, b) => mean(a.map((x, i) => Math.abs(x - b[i])))
  const out = {}
  for (const [name, variant] of [['impact', 'ship_impact'], ['ambiguity', 'ship_ambiguity']]) {
    const full = valueRows(fx, records, 'full', name)
    const ship = new Map()
    for (const rec of records.filter(r => r.ok && r.phase === 'ship' && r.variant === variant)) {
      const note = noteById(fx, rec.noteId), byKey = Object.fromEntries(rec.candidates.map((s, i) => [s, rec.answers[`${name}_${i}`].noul]))
      if (!ship.has(note.id)) ship.set(note.id, [])
      ship.get(note.id).push({ repeat: rec.repeat, v: note.candidates.map(c => byKey[c.surface]) })
    }
    const crossVariant = [], withinFull = []
    for (const [id, reps] of full) {
      const s = ship.get(id); if (!s) continue
      for (const r of reps) { const m = s.find(x => x.repeat === r.repeat); if (m) crossVariant.push(...r.v.map((x, i) => Math.abs(x - m.v[i]))) }
      for (let a = 0; a < reps.length; a++) for (let b = a + 1; b < reps.length; b++) withinFull.push(...reps[a].v.map((x, i) => Math.abs(x - reps[b].v[i])))
    }
    out[name] = { crossVariantMeanAbsDiff: crossVariant.length ? mean(crossVariant) : null, withinVariantMeanAbsDiff: withinFull.length ? mean(withinFull) : null, pairs: crossVariant.length }
  }
  const rev = []
  for (const id of REVERSE_NOTES) {
    const note = noteById(fx, id)
    for (const name of ['impact', 'ambiguity']) {
      const reversed = records.filter(r => r.ok && r.phase === 'reverse' && r.noteId === id)
      const fwd = valueRows(fx, records, 'full', name).get(id)
      if (!reversed.length || !fwd) continue
      const fm = note.candidates.map((_, i) => mean(fwd.map(r => r.v[i])))
      const rm = note.candidates.map((c, i) => mean(reversed.map(r => r.answers[`${name}_${r.candidates.indexOf(c.surface)}`].noul)))
      rev.push({ noteId: id, name, meanAbsDiff: meanAbs(fm, rm), maxAbsDiff: Math.max(...fm.map((x, i) => Math.abs(x - rm[i]))) })
    }
  }
  out.reverse = rev
  return out
}

export function analyze(fx, records, meta = {}) {
  const R = { meta, records: records.length }
  const full = ['impact', 'ambiguity'].map(n => [n, valueRows(fx, records, 'full', n)])
  const rows = Object.fromEntries(full)
  const crit = {
    impact: rows.impact, ambiguity: rows.ambiguity,
    'mean(imp,amb)': combine(rows.impact, rows.ambiguity, (a, b) => (a + b) / 2),
    'max(imp,amb)': combine(rows.impact, rows.ambiguity, Math.max),
    'imp*amb': combine(rows.impact, rows.ambiguity, (a, b) => a * b),
    impactScore: valueRows(fx, records, 'score', 'impactScore', v => v / (SCORE_LEVELS - 1)),
    ambiguityScore: valueRows(fx, records, 'score', 'ambiguityScore', v => v / (SCORE_LEVELS - 1)),
    'v2 impact2': valueRows(fx, records, 'v2', 'impact2'),
    'v2 ambiguity2': valueRows(fx, records, 'v2', 'ambiguity2'),
    'v2 object': valueRows(fx, records, 'v2', 'object'),
    'v3 central': valueRows(fx, records, 'v3', 'central'),
  }
  R.accuracy = {}
  R.stability = {}
  for (const [name, r] of Object.entries(crit)) {
    if (!r.size) continue
    R.accuracy[name] = evaluate(fx, r, name)
    if (!name.includes('*') && !name.includes('(')) R.stability[name] = stabilityOf(fx, r, name)
  }
  const labelStats = {
    notes: fx.notes.length, candidates: fx.notes.reduce((a, n) => a + n.candidates.length, 0),
    underline: fx.notes.reduce((a, n) => a + n.underline.length, 0), unsure: fx.notes.reduce((a, n) => a + n.unsure.length, 0),
    notesOverCap: fx.notes.filter(n => n.underline.length > CAP).length, notesWithMoreThanCapCandidates: fx.notes.filter(n => n.candidates.length > CAP).length,
    notesWithoutPositive: fx.notes.filter(n => !n.underline.length).length,
  }
  R.labels = labelStats
  if (fx.notes.some(n => n.central)) {
    R.central = { positives: fx.notes.reduce((a, n) => a + (n.central?.length ?? 0), 0), criteria: {} }
    for (const [name, r] of Object.entries(crit)) {
      if (!r.size) continue
      const items = itemsFrom(fx, r)
      const bt = bestThreshold(items, 'central')
      R.central.criteria[name] = {
        label: name, auc: auc(items, 'central'), within: withinNoteAuc(items, 'central'), top1: top1Hit(items, 'central'),
        top3: tally(items, it => pick(it.note, it.v, { type: 'top' }), 'central'), bestT: bt,
        capped: THRESHOLDS.map(t => ({ t, ...tally(items, it => pick(it.note, it.v, { type: 'capped', t }), 'central') })),
        aucCI: bootstrap(items, s => auc(s, 'central')),
      }
    }
    const base = fx.notes.map(note => ({ note, v: note.candidates.map(() => 0) }))
    R.central.baselineRank = tally(base, it => new Set(it.note.baselineTop3), 'central')
    R.central.underlineVsCentral = { both: fx.notes.reduce((a, n) => a + n.underline.filter(s => n.central?.includes(s)).length, 0), underlineOnly: fx.notes.reduce((a, n) => a + n.underline.filter(s => !n.central?.includes(s)).length, 0), centralOnly: fx.notes.reduce((a, n) => a + (n.central ?? []).filter(s => !n.underline.includes(s)).length, 0) }
  }
  const chooserBaseline = it => new Set(it.note.baselineTop3)
  const base = fx.notes.map(note => ({ note, v: note.candidates.map(() => 0) }))
  R.baseline = {
    rank: Object.fromEntries(['negative', 'positive', 'drop'].map(m => [m, tally(base, chooserBaseline, m)])),
    first3: Object.fromEntries(['negative', 'positive', 'drop'].map(m => [m, tally(base, it => pick(it.note, it.v, { type: 'first' }), m)])),
    randomExpected: (() => { let tp = 0, sel = 0, pos = 0; for (const n of fx.notes) { const k = Math.min(CAP, n.candidates.length); tp += k * n.underline.length / n.candidates.length; sel += k; pos += n.underline.length } return prf(tp, sel - tp, pos - tp) })(),
    top1: top1Hit(base.map(b => ({ note: b.note, v: b.note.candidates.map(c => -b.note.baselineTop3.indexOf(c.surface) - (b.note.baselineTop3.includes(c.surface) ? 0 : 1000)) }))),
  }
  if (rows.impact.size && rows.ambiguity.size) {
    const ia = itemsFrom(fx, rows.impact), aa = itemsFrom(fx, rows.ambiguity)
    const byId = new Map(aa.map(x => [x.note.id, x]))
    const paired = ia.filter(x => byId.has(x.note.id)).map(x => ({ note: x.note, v: x.v, w: byId.get(x.note.id).v }))
    const ti = R.accuracy.impact.bestT, ta = R.accuracy.ambiguity.bestT
    R.compare = {
      aucDiff: auc(paired) - auc(paired.map(p => ({ note: p.note, v: p.w }))),
      aucDiffCI: bootstrap(paired, s => auc(s) - auc(s.map(p => ({ note: p.note, v: p.w })))),
      f1Diff: tally(paired, it => pick(it.note, it.v, { type: 'capped', t: ti })).f1 - tally(paired, it => pick(it.note, it.w, { type: 'capped', t: ta })).f1,
      f1DiffCI: bootstrap(paired, s => tally(s, it => pick(it.note, it.v, { type: 'capped', t: ti })).f1 - tally(s, it => pick(it.note, it.w, { type: 'capped', t: ta })).f1),
      thresholds: { impact: ti, ambiguity: ta },
      aucCI: { impact: bootstrap(ia, s => auc(s)), ambiguity: bootstrap(aa, s => auc(s)) },
      /* 現行ルール rank との F1 の差（上限3つの規則、閾値は固定）。0 を含めば、現行ルールと区別できない */
      vsRank: Object.fromEntries([['impact', paired.map(p => ({ note: p.note, v: p.v })), ti], ['ambiguity', paired.map(p => ({ note: p.note, v: p.w })), ta]].map(([name, items, t]) => {
        const f1 = s => tally(s, it => pick(it.note, it.v, { type: 'capped', t })).f1 - tally(s, it => new Set(it.note.baselineTop3)).f1
        return [name, { diff: f1(items), ci: bootstrap(items, f1) }]
      })),
    }
  }
  R.kindShape = kindShape(fx, records)
  R.latency = latencyReport(records)
  R.cost = costReport(records)
  R.consistency = consistency(fx, records)
  R.birthday = birthdayTable(fx, records, crit, R)
  return R
}

function birthdayTable(fx, records, crit, R) {
  const note = noteById(fx, 'birthday'), ks = R.kindShape.kinds.filter(k => k.noteId === 'birthday')
  const mm = (rows, i) => { const xs = rows?.get('birthday')?.map(r => r.v[i]); return xs?.length ? { mean: mean(xs), min: Math.min(...xs), max: Math.max(...xs) } : null }
  return note.candidates.map((c, i) => ({
    surface: c.surface, kind: c.kind, label: note.underline.includes(c.surface) ? 'underline' : note.unsure.includes(c.surface) ? 'unsure' : '-',
    baseline: note.baselineTop3.includes(c.surface),
    central: note.central?.includes(c.surface) ? 'central' : '-',
    values: Object.fromEntries(['impact', 'ambiguity', 'impactScore', 'ambiguityScore', 'v2 impact2', 'v2 ambiguity2', 'v2 object', 'v3 central'].map(name => [name, mm(crit[name], i)])),
    jevKind: ks.find(k => k.surface === c.surface),
  }))
}

/* ============ 表示 ============ */
const f2 = x => x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(2)
const f3 = x => x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(3)
const ms = x => x === null || x === undefined ? '-' : `${Math.round(x)}`
const pct = x => x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
const prfCell = r => `${pct(r.precision)} (${r.tp}/${r.tp + r.fp}) / ${pct(r.recall)} (${r.tp}/${r.tp + r.fn}) / ${f2(r.f1)}`

export function renderMarkdown(R) {
  const L = []
  const h = s => L.push(`\n## ${s}\n`)
  L.push(`# Jev 計測 (${R.meta.startedAt ?? ''})`, '', `records: ${R.records}, model: ${R.cost.models.join(', ')}, fixture sha256: ${R.meta.fixtureSha256 ?? '?'}`)
  const lb = R.labels
  L.push('', `ラベル: 付箋 ${lb.notes} 件、候補 ${lb.candidates} 語、underline ${lb.underline} 語、unsure ${lb.unsure} 語。3語を超える underline の付箋 ${lb.notesOverCap} 件、下線なしの付箋 ${lb.notesWithoutPositive} 件、候補が4語以上の付箋 ${lb.notesWithMoreThanCapCandidates} 件。`)

  h('レイテンシ（クライアント側、ミリ秒、逐次）')
  L.push(table(['group', 'n', 'min', 'p50', 'mean', 'p95', 'max', '>1000', '>1500', 'questions p50', 'input tok p50', 'output tok p50'],
    R.latency.groups.map(g => [g.name, g.n, ms(g.min), ms(g.p50), ms(g.mean), ms(g.p95), ms(g.max), g.over1000, g.over1500, g.questions.p50, ms(g.inputTokens.p50), ms(g.outputTokens.p50)])))
  L.push('', `warmup (集計外): ${R.latency.warmupMs.map(ms).join(', ')} ms`, '', 'main の周回ごと（キャッシュの有無の確認）:', table(['repeat', 'n', 'p50', 'p95', 'max'], R.latency.rounds.map(r => [r.repeat, r.n, ms(r.p50), ms(r.p95), ms(r.max)])))
  L.push('', '質問数を振る（state 固定）:', table(['variant', 'questions', 'n', 'p50', 'min', 'max', 'input tok', 'output tok', 'bytes'], R.latency.scalingQuestions.map(s => [s.variant, s.questions, s.n, ms(s.p50), ms(s.min), ms(s.max), ms(s.inputTokens), ms(s.outputTokens), s.requestBytes])))
  L.push('', 'state を長くする（質問4つ固定）:', table(['variant', 'questions', 'n', 'p50', 'min', 'max', 'input tok', 'output tok', 'bytes'], R.latency.scalingState.map(s => [s.variant, s.questions, s.n, ms(s.p50), ms(s.min), ms(s.max), ms(s.inputTokens), ms(s.outputTokens), s.requestBytes])))
  const rg = (name, o, k = 1, unit = '') => o ? `${name}: ${f2(o.slope * k)} ms/${unit || '単位'}, 切片 ${ms(o.intercept)} ms, R2 ${f2(o.r2)}` : `${name}: -`
  const rr = R.latency.regression
  L.push('', '回帰（遅延 ~ 1つの説明変数）:', `- 付箋の実リクエスト n=${rr.pooledNotes.n}: ${rg('質問数', rr.pooledNotes.questions, 1, '質問')}; ${rg('input tokens', rr.pooledNotes.inputTokens, 1000, '1k tok')}; ${rg('output tokens', rr.pooledNotes.outputTokens, 1000, '1k tok')}; ${rg('bytes', rr.pooledNotes.requestBytes, 1000, '1k bytes')}`)
  L.push(`- 質問数を振った実験 n=${rr.scalingQuestions.n}: ${rg('質問数', rr.scalingQuestions.questions, 1, '質問')}; ${rg('input tokens', rr.scalingQuestions.inputTokens, 1000, '1k tok')}; ${rg('output tokens', rr.scalingQuestions.outputTokens, 1000, '1k tok')}`)
  L.push(`- state を長くした実験 n=${rr.scalingState.n}: ${rg('input tokens', rr.scalingState.inputTokens, 1000, '1k tok')}`)
  L.push('', `失敗: ${R.latency.failures.length} 件 ${JSON.stringify(R.latency.failures)}`, `リトライ: ${R.latency.retried.length} 件 ${JSON.stringify(R.latency.retried)}`)

  h('費用')
  L.push(table(['phase', 'requests', 'input tok', 'output tok', 'USD'], R.cost.phases.map(p => [p.phase, p.requests, p.inputTokens, p.outputTokens, p.usd.toFixed(5)])))
  L.push('', `合計 ${R.cost.totalRequests} requests, input ${R.cost.totalInputTokens} tokens, $${R.cost.totalUsd.toFixed(5)}。出荷する形の1リクエスト: ${ms(R.cost.perShipRequestTokens)} tokens, $${(R.cost.perShipRequestUsd ?? 0).toFixed(6)}。`)

  h('ぶれ（同じ質問を3回）')
  L.push(table(['criterion', 'questions', 'range p50', 'range p95', 'range max', 'range=0', 'range>=0.1', 'range>=0.2', 'sd mean', 'top-3 set changed', 'tie at rank3/4'],
    Object.values(R.stability).map(s => [s.label, s.questions, f2(s.range.p50), f2(s.range.p95), f2(s.range.max), `${s.range.zero}/${s.questions}`, `${s.range.ge010}/${s.questions}`, `${s.range.ge020}/${s.questions}`, f3(s.sd.mean), `${s.top3Changed.changed}/${s.top3Changed.notes}`, `${s.tieAtBoundary.ties}/${s.tieAtBoundary.of}`])))
  L.push('', '質問の独立性（full の値と ship の値の、同じ付箋・周回での平均絶対差。ノイズの目安は full の周回どうし）:', table(['criterion', 'full vs ship', 'full 周回どうし', 'pairs'], ['impact', 'ambiguity'].map(n => [n, f3(R.consistency[n].crossVariantMeanAbsDiff), f3(R.consistency[n].withinVariantMeanAbsDiff), R.consistency[n].pairs])))
  L.push('', '候補を逆順で送った（位置の偏り）:', table(['note', 'criterion', 'mean |fwd-rev|', 'max |fwd-rev|'], R.consistency.reverse.map(r => [r.noteId, r.name, f3(r.meanAbsDiff), f3(r.maxAbsDiff)])))

  h('下線を引くべき語との一致（3回の平均値。unsure は付けない側に数える）')
  const A = Object.values(R.accuracy)
  L.push(table(['criterion', 'AUC (neg / pos / drop)', 'within-note AUC', 'top-1 hit', 'top-3 P/R/F1 (tp/sel / tp/pos / F1)', 'best t', 'capped@best P/R/F1'],
    A.map(a => { const c = a.threshold.find(x => x.t === a.bestT).capped; return [a.label, `${f3(a.auc.negative)} / ${f3(a.auc.positive)} / ${f3(a.auc.drop)}`, a.withinNoteAuc ? `${f3(a.withinNoteAuc.mean)} (n=${a.withinNoteAuc.n})` : '-', `${a.top1.hit}/${a.top1.n}`, prfCell(a.top3.negative), a.bestT, prfCell(c)] })))
  const b = R.baseline
  L.push('', `現行ルール rank（種類と出現順の上位3語）: ${prfCell(b.rank.negative)}; unsure を付ける側に数えると ${prfCell(b.rank.positive)}; 無視すると ${prfCell(b.rank.drop)}; top-1 ${b.top1.hit}/${b.top1.n}`)
  L.push(`出現順の先頭3語: ${prfCell(b.first3.negative)}。ランダムに3語を選ぶ期待値: ${prfCell(b.randomExpected)}`)
  for (const a of A) {
    L.push('', `### 閾値 ${a.label}（best t=${a.bestT}）`, table(['t', '閾値のみ P/R/F1', '閾値+上限3 P/R/F1', '+上限3, unsure=drop', '+上限3, unsure=positive'],
      a.threshold.map(x => [x.t, prfCell(x.uncapped), prfCell(x.capped), prfCell(x.cappedDrop), prfCell(x.cappedPositive)])))
    L.push('', `AUC 周回別: ${a.perRepeat.map(p => `r${p.repeat} ${f3(p.auc)} (top3 F1 ${f2(p.top3F1)}, capped@best F1 ${f2(p.cappedF1)})`).join('; ')}`)
  }
  if (R.compare) {
    const c = R.compare
    L.push('', '### 影響 vs あいまいさ（付箋を再標本化したブートストラップ 2000 回、95%区間）',
      `- AUC 差 (impact - ambiguity) = ${f3(c.aucDiff)}  [${f3(c.aucDiffCI.lo)}, ${f3(c.aucDiffCI.hi)}]`,
      `- capped@best の F1 差 = ${f3(c.f1Diff)}  [${f3(c.f1DiffCI.lo)}, ${f3(c.f1DiffCI.hi)}]（閾値は impact ${c.thresholds.impact}、ambiguity ${c.thresholds.ambiguity} に固定）`,
      `- AUC の95%区間: impact [${f3(c.aucCI.impact.lo)}, ${f3(c.aucCI.impact.hi)}]、ambiguity [${f3(c.aucCI.ambiguity.lo)}, ${f3(c.aucCI.ambiguity.hi)}]`,
      `- 現行ルール rank との F1 の差（上限3つの規則）: impact ${f3(c.vsRank.impact.diff)} [${f3(c.vsRank.impact.ci.lo)}, ${f3(c.vsRank.impact.ci.hi)}]、ambiguity ${f3(c.vsRank.ambiguity.diff)} [${f3(c.vsRank.ambiguity.ci.lo)}, ${f3(c.vsRank.ambiguity.ci.hi)}]`)
  }

  if (R.central) {
    const c = R.central, u = c.underlineVsCentral
    h('事後の診断: 依頼の中心の語（central）との一致')
    L.push(`central は jev-notes-central.json（v1 の結果を見たあとに付けたラベル）。central ${c.positives} 語。underline との重なり: 両方 ${u.both} 語、underline のみ ${u.underlineOnly} 語、central のみ ${u.centralOnly} 語。`, '')
    L.push(table(['criterion', 'AUC [95% CI]', 'within-note AUC', 'top-1 hit', 'top-3 P/R/F1', 'best t', 'capped@best P/R/F1'],
      Object.values(c.criteria).map(x => [x.label, `${f3(x.auc)} [${f3(x.aucCI.lo)}, ${f3(x.aucCI.hi)}]`, x.within ? `${f3(x.within.mean)} (n=${x.within.n})` : '-', `${x.top1.hit}/${x.top1.n}`, prfCell(x.top3), x.bestT, prfCell(x.capped.find(t => t.t === x.bestT))])))
    L.push('', `現行ルール rank（central ラベルに対して）: ${prfCell(c.baselineRank)}`)
  }

  h('誕生日の付箋')
  const cell = o => o ? `${f2(o.mean)} [${f2(o.min)}-${f2(o.max)}]` : '-'
  const vnames = Object.keys(R.birthday[0].values)
  L.push('値は3回の平均 [最小-最大]。score は 0..1 に正規化（score/3）。', '')
  L.push(table(['word', 'board kind', 'label', 'central', 'rank top3', ...vnames, 'jev kind (votes, conf)'],
    R.birthday.map(r => [r.surface, r.kind, r.label, r.central, r.baseline ? 'yes' : '', ...vnames.map(n => cell(r.values[n])), r.jevKind ? `${r.jevKind.choice} (${r.jevKind.votes}/${r.jevKind.of}, ${f2(r.jevKind.confidence)})` : '-'])))

  h('kind と shape')
  const k = R.kindShape
  L.push(`kind の分布（全候補 ${k.kinds.length} 語）: ${JSON.stringify(k.kindDist)}`, `kind の分布（underline の語）: ${JSON.stringify(k.kindDistUnderlined)}`, `kind の3回一致: ${k.kindAgree.all}/${k.kindAgree.of}、確信度 p50 ${f2(k.kindConfidence.p50)} min ${f2(k.kindConfidence.min)} p95 ${f2(k.kindConfidence.p95)}`)
  L.push('', `shape の分布: ${JSON.stringify(k.shapeDist)}、3回一致 ${k.shapeAgree.all}/${k.shapeAgree.of}、確信度 p50 ${f2(k.shapeConfidence.p50)} min ${f2(k.shapeConfidence.min)}`)
  L.push('', table(['note', 'shape', 'votes', 'conf'], k.shapes.map(s => [s.noteId, s.choice, `${s.votes}/${s.of}`, f2(s.confidence)])))
  L.push('', table(['note', 'word', 'label', 'kind', 'votes', 'conf'], k.kinds.map(x => [x.noteId, x.surface, x.label, x.choice, `${x.votes}/${x.of}`, f2(x.confidence)])))
  return L.join('\n') + '\n'
}

/* ============ 基準 B の集計（語と句の spans。Issue #1） ============
   値は assume（noul）の3回の平均。正解は重ならない単位の集合（fixture の underline。単位は語か句）。
   protocol は tools/jev-notes-b.json に、run の前に決めて書いてある。 */
export const CAPS = [3, 4, 5]
const SET_NAMES = ['old', 'heldout', 'pooled']
const notesOf = (fx, set) => fx.notes.filter(n => set === 'pooled' || n.set === set)
const mlabel = m => Number.isFinite(m) ? m : 'inf'

/* 正解の単位（note.spans の添字）。mode: negative（unsure は付けない側）/ positive（unsure も付ける。underline と重なるものは除く）/ drop（unsure は数えない）。
   unsure: drop のとき数えない添字。overlapOnly: 正解の単位と重なるが同じではない spans（AUC から除く） */
const goldCache = new WeakMap()
export function goldOf(note, mode = 'negative') {
  const byMode = goldCache.get(note) ?? goldCache.set(note, new Map()).get(note)
  if (!byMode.has(mode)) byMode.set(mode, goldOfUncached(note, mode))
  return byMode.get(mode)
}
function goldOfUncached(note, mode) {
  const idx = new Map(note.spans.map((s, i) => [s.surface, i]))
  const U = note.underline.map(x => idx.get(x)), N = note.unsure.map(x => idx.get(x))
  const gold = new Set(U)
  if (mode === 'positive') for (const i of N) if (![...gold].some(g => overlaps(note.spans[i], note.spans[g]))) gold.add(i)
  const unsure = new Set(mode === 'drop' ? N : [])
  const overlapOnly = new Set()
  note.spans.forEach((s, i) => { if (!gold.has(i) && [...gold].some(g => overlaps(s, note.spans[g]))) overlapOnly.add(i) })
  return { gold, unsure, overlapOnly }
}

/* spans の全てについての AUC。正例は正解の単位、負例はどの正解の単位とも重ならない spans。only で対象を絞る（語だけ、など） */
export function aucSpans(items, { mode = 'negative', only = null } = {}) {
  const P = [], N = []
  for (const { note, v } of items) {
    const { gold, unsure, overlapOnly } = goldOf(note, mode)
    note.spans.forEach((s, i) => {
      if ((only && !only(s)) || unsure.has(i) || overlapOnly.has(i) || !Number.isFinite(v[i])) return
      ;(gold.has(i) ? P : N).push(v[i])
    })
  }
  if (!P.length || !N.length) return null
  let s = 0
  for (const p of P) for (const n of N) s += p > n ? 1 : p === n ? 0.5 : 0
  return s / (P.length * N.length)
}

/* chooser(it) は spans の添字の配列。strict は表記と位置まで一致、lenient は重なれば当たり */
export function tallySpans(items, chooser, { mode = 'negative', lenient = false } = {}) {
  let tp = 0, fp = 0, fn = 0
  for (const it of items) {
    const { gold, unsure } = goldOf(it.note, mode), sel = chooser(it), sp = it.note.spans
    if (!lenient) {
      for (const i of sel) { if (gold.has(i)) tp++; else if (!unsure.has(i)) fp++ }
      for (const g of gold) if (!sel.includes(g)) fn++
    } else {
      for (const i of sel) { if ([...gold].some(g => overlaps(sp[i], sp[g]))) tp++; else if (!unsure.has(i)) fp++ }
      for (const g of gold) if (!sel.some(i => overlaps(sp[i], sp[g]))) fn++
    }
  }
  return prf(tp, fp, fn)
}
const spanChooser = params => it => selectSpans(it.note.spans, it.v, params)
const rankChooser = cap => it => it.note.baselineRank.slice(0, cap).map(sf => it.note.spans.findIndex(s => s.surface === sf)).filter(i => i >= 0)

/* 「の」でつながった語の列ごとの、正解との関係。2語の列は type が merged（正解が句）/ both（正解が両方の語）/ one（片方の語）/ none。3語以上は chainN */
export function chainInfos(note, mode = 'negative') {
  const { gold } = goldOf(note, mode)
  return chainsOf(note.spans).map(ch => {
    const inside = note.spans.map((_, i) => i).filter(i => within(note.spans[i], ch.span))
    const parts = inside.filter(i => !note.spans[i].merged), merged = inside.filter(i => note.spans[i].merged)
    const goldIn = inside.filter(i => gold.has(i))
    const type = parts.length === 2 ? (gold.has(merged[0]) ? 'merged' : goldIn.length === 2 ? 'both' : goldIn.length === 1 ? 'one' : 'none') : `chain${parts.length}`
    return { surface: ch.span.surface, span: ch.span, nParts: parts.length, type, inside, parts, merged, goldIn }
  })
}
const decisionTypes = ['merged', 'both']

/* 句が語に勝つかだけの判定の正答率。2語の列で、正解が句か両方の語のものだけを数える。t と cap には依らない */
export function chainDecision(items, margin) {
  let n = 0, ok = 0
  for (const it of items) for (const ch of chainInfos(it.note)) {
    if (!decisionTypes.includes(ch.type)) continue
    n++
    if (mergeWins(ch.span, it.note.spans, it.v, margin) === (ch.type === 'merged')) ok++
  }
  return { n, ok, rate: n ? ok / n : null }
}

/* 選択まで通したときに、列の中の選択が正解と一致した数。type ごと */
export function chainEnd(items, params) {
  const out = {}
  for (const it of items) {
    const sel = selectSpans(it.note.spans, it.v, params)
    for (const ch of chainInfos(it.note)) {
      const selIn = sel.filter(i => ch.inside.includes(i)), goldSet = new Set(ch.goldIn)
      const hit = selIn.length === goldSet.size && selIn.every(i => goldSet.has(i))
      const o = out[ch.type] ??= { total: 0, matched: 0 }
      o.total++; if (hit) o.matched++
    }
  }
  return out
}

/* protocol.tuning の規則: strict F1 が最大の (t, margin)。0.02 以内で並ぶなら、適合率、句の判定の正答率、t が高い方、margin が小さい方の順 */
export function tuneB(items, cap, { margins = MARGINS, ts = THRESHOLDS } = {}) {
  const rows = []
  for (const margin of margins) {
    const dec = chainDecision(items, margin)
    for (const t of ts) rows.push({ t, margin, ...tallySpans(items, spanChooser({ t, cap, margin })), chainAcc: dec.rate })
  }
  const top = Math.max(...rows.map(r => r.f1))
  const near = rows.filter(r => r.f1 >= top - 0.02)
  near.sort((a, b) => (b.precision ?? 0) - (a.precision ?? 0) || (b.chainAcc ?? -1) - (a.chainAcc ?? -1) || b.t - a.t || (a.margin < b.margin ? -1 : a.margin > b.margin ? 1 : 0))
  return { best: near[0], rows }
}

/* note.id -> repeat 順の { repeat, v }（v は note.spans と同じ並び。記録に無い span は NaN） */
export function spanRows(fx, records, phase, variant, name = 'assume', extra = '') {
  const out = new Map()
  for (const rec of records.filter(r => r.ok && r.phase === phase && r.variant === variant && (r.extra ?? '') === extra)) {
    const note = noteById(fx, rec.noteId)
    const byKey = Object.fromEntries(rec.candidates.map((s, i) => [s, rec.answers[`${name}_${i}`]]))
    const v = note.spans.map(s => { const a = byKey[s.surface]; return a ? (a.type === 'noul' ? a.noul : a.score) : NaN })
    if (!out.has(note.id)) out.set(note.id, [])
    out.get(note.id).push({ repeat: rec.repeat, v })
  }
  for (const rows of out.values()) rows.sort((a, b) => a.repeat - b.repeat)
  return out
}
export const spanItems = (fx, rows, set = 'pooled') => notesOf(fx, set).filter(n => rows.has(n.id)).map(note => {
  const reps = rows.get(note.id).map(r => r.v)
  return { note, reps, v: note.spans.map((_, i) => { const xs = reps.map(r => r[i]).filter(Number.isFinite); return xs.length ? round6(mean(xs)) : NaN }) }
})

function recallCeiling(notes, cap) {
  let g = 0, m = 0
  for (const n of notes) { g += n.underline.length; m += Math.min(n.underline.length, cap) }
  return { gold: g, reachable: m, rate: g ? m / g : null }
}

/* 3回の選択が同じか（閾値の規則）と、閾値なしの上位 k（重ならない k 個）が同じか */
function stabilityB(items, params) {
  const key = (note, v, p) => selectSpans(note.spans, v, p).map(i => note.spans[i].surface).sort().join('|')
  const run = p => {
    let same = 0, n = 0, jac = []
    for (const it of items) {
      if (it.reps.length < 2) continue
      const sets = it.reps.map(v => new Set(selectSpans(it.note.spans, v, p).map(i => it.note.spans[i].surface)))
      n++; if (new Set(sets.map(s => [...s].sort().join('|'))).size === 1) same++
      for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
        const u = new Set([...sets[a], ...sets[b]]); jac.push(u.size ? [...sets[a]].filter(x => sets[b].has(x)).length / u.size : 1)
      }
    }
    return { same, notes: n, meanJaccard: jac.length ? mean(jac) : null }
  }
  return { rule: run(params), topK: Object.fromEntries(CAPS.map(k => [k, run({ t: 0, cap: k, margin: params.margin })])) }
}

/* 取りこぼしと誤りの理由。取りこぼし: 値が t 未満 / 別の選択と重なる（句か語かの食い違い、競合） / cap で溢れた。誤り: unsure / 正解の単位と重なる（粒度違い） / 負 */
function limiterB(items, params) {
  const o = { gold: 0, hit: 0, missBelowT: 0, missOverlap: 0, missCap: 0, selected: 0, fpUnsure: 0, fpGranularity: 0, fpNegative: 0 }
  for (const it of items) {
    const { gold } = goldOf(it.note), sel = selectSpans(it.note.spans, it.v, params), sp = it.note.spans
    for (const g of gold) {
      o.gold++
      if (sel.includes(g)) o.hit++
      else if (it.v[g] < params.t - 1e-9) o.missBelowT++
      else if (sel.some(i => overlaps(sp[i], sp[g]))) o.missOverlap++
      else o.missCap++
    }
    for (const i of sel) {
      o.selected++
      if (gold.has(i)) continue
      if (it.note.unsure.includes(sp[i].surface)) o.fpUnsure++
      else if ([...gold].some(g => overlaps(sp[i], sp[g]))) o.fpGranularity++
      else o.fpNegative++
    }
  }
  return o
}

function pairedDelta(items, A, B, opt = {}) {
  const f = s => tallySpans(s, A, opt).f1 - tallySpans(s, B, opt).f1
  return { diff: f(items), ci: bootstrap(items, f) }
}

export function analyzeB(fx, records, meta = {}) {
  const R = { meta, records: records.length }
  const rows = spanRows(fx, records, 'b', 'spans')
  const partsRows = spanRows(fx, records, 'bparts', 'parts')
  const revRows = spanRows(fx, records, 'brev', 'spans', 'assume', 'reverse')
  const it = Object.fromEntries(SET_NAMES.map(s => [s, spanItems(fx, rows, s)]))
  const itParts = Object.fromEntries(SET_NAMES.map(s => [s, spanItems(fx, partsRows, s)]))

  R.labels = Object.fromEntries(SET_NAMES.map(s => {
    const ns = notesOf(fx, s), chains = ns.flatMap(n => chainInfos(n).map(c => c.type))
    return [s, {
      notes: ns.length, words: ns.reduce((a, n) => a + n.candidates.length, 0), spans: ns.reduce((a, n) => a + n.spans.length, 0),
      mergedSpans: ns.reduce((a, n) => a + n.spans.filter(x => x.merged).length, 0), underlineUnits: ns.reduce((a, n) => a + n.underline.length, 0),
      underlineMergedUnits: ns.reduce((a, n) => a + n.underline.filter(u => n.spans.find(x => x.surface === u)?.merged).length, 0), unsure: ns.reduce((a, n) => a + n.unsure.length, 0),
      notesWithoutUnderline: ns.filter(n => !n.underline.length).length,
      overCap: Object.fromEntries(CAPS.map(c => [c, ns.filter(n => n.underline.length > c).length])),
      underlineHistogram: Object.entries(ns.reduce((h, n) => (h[n.underline.length] = (h[n.underline.length] ?? 0) + 1, h), {})).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]),
      recallCeiling: Object.fromEntries(CAPS.map(c => [c, recallCeiling(ns, c)])),
      chainTypes: chains.reduce((h, t) => (h[t] = (h[t] ?? 0) + 1, h), {}),
    }]
  }))

  const ranges = []
  for (const reps of rows.values()) reps[0].v.forEach((_, i) => { const xs = reps.map(r => r.v[i]).filter(Number.isFinite); if (xs.length > 1) ranges.push(Math.max(...xs) - Math.min(...xs)) })
  R.noise = { ...summary(ranges), p95: ranges.length ? quantile(ranges, 0.95) : null, zero: ranges.filter(x => x === 0).length, ge010: ranges.filter(x => x >= 0.1 - 1e-9).length }

  R.auc = Object.fromEntries(SET_NAMES.map(s => [s, {
    spans: auc2(it[s]), wordsInSpansRequest: auc2(it[s], x => !x.merged), wordsInPartsRequest: auc2(itParts[s], x => !x.merged),
    mergedOnly: auc2(it[s], x => x.merged),
    unsurePositive: aucSpans(it[s], { mode: 'positive' }), unsureDrop: aucSpans(it[s], { mode: 'drop' }),
  }]))
  function auc2(items, only = null) { return items.length ? { auc: aucSpans(items, { only }), ci: bootstrap(items, x => aucSpans(x, { only })) } : null } // eslint-disable-line

  // old で選んだ値を、全ての set で評価する
  R.tuned = {}
  for (const cap of CAPS) {
    const merge = tuneB(it.old, cap), words = tuneB(it.old, cap, { margins: [Infinity] })
    const own = tuneB(it.heldout, cap), ownWords = tuneB(it.heldout, cap, { margins: [Infinity] })
    const evalSet = (items, params) => ({ strict: tallySpans(items, spanChooser(params)), lenient: tallySpans(items, spanChooser(params), { lenient: true }), drop: tallySpans(items, spanChooser(params), { mode: 'drop' }), positive: tallySpans(items, spanChooser(params), { mode: 'positive' }) })
    const mp = { t: merge.best.t, cap, margin: merge.best.margin }, wp = { t: words.best.t, cap, margin: Infinity }
    R.tuned[cap] = {
      mergeParams: { t: mp.t, margin: mlabel(mp.margin) }, wordsParams: { t: wp.t }, heldoutOwnMerge: { t: own.best.t, margin: mlabel(own.best.margin), f1: own.best.f1 }, heldoutOwnWords: { t: ownWords.best.t, f1: ownWords.best.f1 },
      merge: Object.fromEntries(SET_NAMES.map(s => [s, evalSet(it[s], mp)])),
      words: Object.fromEntries(SET_NAMES.map(s => [s, evalSet(it[s], wp)])),
      rank: Object.fromEntries(SET_NAMES.map(s => [s, { strict: tallySpans(it[s], rankChooser(cap)), lenient: tallySpans(it[s], rankChooser(cap), { lenient: true }) }])),
      mergeVsWords: Object.fromEntries(SET_NAMES.map(s => [s, pairedDelta(it[s], spanChooser(mp), spanChooser(wp))])),
      mergeVsRank: Object.fromEntries(SET_NAMES.map(s => [s, { strict: pairedDelta(it[s], spanChooser(mp), rankChooser(cap)), lenient: pairedDelta(it[s], spanChooser(mp), rankChooser(cap), { lenient: true }) }])),
      wordsVsRank: Object.fromEntries(SET_NAMES.map(s => [s, pairedDelta(it[s], spanChooser(wp), rankChooser(cap))])),
      f1Ceiling: Object.fromEntries(SET_NAMES.map(s => { const c = R.labels[s].recallCeiling[cap]; const g = c.gold; return [s, g ? (2 * c.rate) / (1 + c.rate) : null] })),
    }
  }

  // cap の推奨: heldout の strict F1（old で選んだ値）が最大の cap から 0.02 以内で、最小の cap
  const hf = Object.fromEntries(CAPS.map(c => [c, R.tuned[c].merge.heldout.strict.f1])), best = Math.max(...Object.values(hf))
  const recCap = CAPS.find(c => hf[c] >= best - 0.02)
  R.recommended = { cap: recCap, t: R.tuned[recCap].mergeParams.t, margin: R.tuned[recCap].mergeParams.margin, heldoutF1ByCap: hf }
  const rp = { t: R.recommended.t, cap: recCap, margin: R.recommended.margin === 'inf' ? Infinity : R.recommended.margin }

  // 全格子（参考）
  R.grid = []
  for (const s of SET_NAMES) for (const cap of CAPS) for (const margin of MARGINS) for (const t of THRESHOLDS) {
    const strict = tallySpans(it[s], spanChooser({ t, cap, margin }))
    R.grid.push({ set: s, cap, t, margin: mlabel(margin), tp: strict.tp, fp: strict.fp, fn: strict.fn, precision: strict.precision, recall: strict.recall, f1: strict.f1 })
  }

  // 句の判定と、選択まで通した結果
  R.merge = {
    byMargin: MARGINS.map(m => ({
      margin: mlabel(m),
      decision: Object.fromEntries(SET_NAMES.map(s => [s, chainDecision(it[s], m)])),
      f1AtRecommended: Object.fromEntries(SET_NAMES.map(s => [s, tallySpans(it[s], spanChooser({ ...rp, margin: m })).f1])),
      end: Object.fromEntries(SET_NAMES.map(s => [s, chainEnd(it[s], { ...rp, margin: m })])),
    })),
    chains: [],
  }
  for (const note of fx.notes) {
    const item = it.pooled.find(x => x.note.id === note.id); if (!item) continue
    const sel = selectSpans(note.spans, item.v, rp)
    for (const ch of chainInfos(note)) {
      const selIn = sel.filter(i => ch.inside.includes(i))
      const max = Math.max(...ch.parts.map(i => item.v[i]))
      R.merge.chains.push({
        note: note.id, set: note.set, chain: ch.surface, nParts: ch.nParts, label: ch.type, goldIn: ch.goldIn.map(i => note.spans[i].surface),
        values: Object.fromEntries(ch.inside.map(i => [note.spans[i].surface, item.v[i]])), d: ch.nParts === 2 ? item.v[ch.merged[0]] - max : null,
        selected: selIn.map(i => note.spans[i].surface), matched: selIn.length === ch.goldIn.length && selIn.every(i => ch.goldIn.includes(i)),
      })
    }
  }
  const dOf = (set, type) => R.merge.chains.filter(c => c.d !== null && c.label === type && (set === 'pooled' || c.set === set)).map(c => c.d)
  R.merge.d = Object.fromEntries(SET_NAMES.map(s => [s, {
    ...Object.fromEntries(['merged', 'both', 'one', 'none'].map(t => [t, { n: dOf(s, t).length, mean: dOf(s, t).length ? mean(dOf(s, t)) : null, min: dOf(s, t).length ? Math.min(...dOf(s, t)) : null, max: dOf(s, t).length ? Math.max(...dOf(s, t)) : null }])),
    aucMergedVsBoth: (() => { const P = dOf(s, 'merged'), N = dOf(s, 'both'); if (!P.length || !N.length) return null; let a = 0; for (const p of P) for (const n of N) a += p > n ? 1 : p === n ? 0.5 : 0; return a / (P.length * N.length) })(),
  }]))

  R.stability = Object.fromEntries(['old', 'heldout'].map(s => [s, stabilityB(it[s], rp)]))
  R.limiter = Object.fromEntries(SET_NAMES.map(s => [s, limiterB(it[s], rp)]))

  // 句を足しても語の値が動かないか（parts と spans の語の値の差）、位置の偏り（逆順）
  const wordDiffs = [], betweenRepeats = []
  for (const [id, reps] of rows) {
    const note = noteById(fx, id), pr = partsRows.get(id); if (!pr) continue
    note.spans.forEach((s, i) => {
      if (s.merged) return
      const a = mean(reps.map(r => r.v[i])), b = mean(pr.map(r => r.v[i]))
      wordDiffs.push(Math.abs(a - b))
      for (let x = 0; x < reps.length; x++) for (let y = x + 1; y < reps.length; y++) betweenRepeats.push(Math.abs(reps[x].v[i] - reps[y].v[i]))
    })
  }
  R.contamination = {
    wordsMeanAbsDiffPartsVsSpans: wordDiffs.length ? mean(wordDiffs) : null, wordsMeanAbsDiffBetweenRepeats: betweenRepeats.length ? mean(betweenRepeats) : null, n: wordDiffs.length,
    f1PartsRequestWordsOnly: Object.fromEntries(SET_NAMES.map(s => [s, itParts[s].length ? tallySpans(itParts[s], spanChooser({ t: R.tuned[recCap].wordsParams.t, cap: recCap, margin: Infinity })).f1 : null])),
  }
  const rev = []
  for (const [id, rr] of revRows) {
    const note = noteById(fx, id), fwd = rows.get(id); if (!fwd) continue
    const fm = note.spans.map((_, i) => mean(fwd.map(r => r.v[i]))), rm = note.spans.map((_, i) => mean(rr.map(r => r.v[i])))
    const item = it.pooled.find(x => x.note.id === id)
    const selF = selectSpans(note.spans, fm, rp).map(i => note.spans[i].surface).sort().join('|'), selR = selectSpans(note.spans, rm, rp).map(i => note.spans[i].surface).sort().join('|')
    rev.push({ note: id, meanAbsDiff: mean(fm.map((x, i) => Math.abs(x - rm[i]))), maxAbsDiff: Math.max(...fm.map((x, i) => Math.abs(x - rm[i]))), sameSelection: selF === selR, item: !!item })
  }
  R.reverse = rev

  // kind と shape（出荷する形で聞いた分）
  const recsB = records.filter(r => r.ok && r.phase === 'b' && r.variant === 'spans')
  const kinds = [], shapes = []
  for (const note of fx.notes) {
    const rs = recsB.filter(r => r.noteId === note.id); if (!rs.length) continue
    note.spans.forEach(s => {
      const ans = rs.map(r => r.answers[`kind_${r.candidates.indexOf(s.surface)}`]).filter(Boolean); if (!ans.length) return
      const [choice, votes] = modal(ans.map(a => a.choice))
      kinds.push({ note: note.id, surface: s.surface, merged: s.merged, gold: note.underline.includes(s.surface), choice, votes, of: ans.length, confidence: mean(ans.filter(a => a.choice === choice).map(a => a.confidence)) })
    })
    const sa = rs.map(r => r.answers.shape), [choice, votes] = modal(sa.map(a => a.choice))
    shapes.push({ note: note.id, choice, votes, of: sa.length })
  }
  const dist = xs => Object.fromEntries([...groupBy(xs, r => r.choice)].map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1]))
  const unanimous = xs => ({ all: xs.filter(k => k.votes === k.of).length, of: xs.length })
  R.kindShape = {
    kindDist: dist(kinds), kindDistGold: dist(kinds.filter(k => k.gold)), kindUnanimous: unanimous(kinds), kindUnanimousGold: unanimous(kinds.filter(k => k.gold)), kindUnanimousMerged: unanimous(kinds.filter(k => k.merged)),
    kindConfidence: kinds.length ? summary(kinds.map(k => k.confidence)) : null, shapeDist: dist(shapes), shapeUnanimous: unanimous(shapes),
  }

  // 遅延・費用・失敗
  const ok = records.filter(r => r.ok && r.phase !== 'warmup'), lat = rs => rs.map(r => r.latencyMs)
  R.latency = ['b', 'bparts', 'brev'].map(p => {
    const rs = ok.filter(r => r.phase === p); if (!rs.length) return null
    return { phase: p, ...summary(lat(rs)), over1000: lat(rs).filter(x => x > 1000).length, questions: summary(rs.map(r => r.questions)), inputTokens: summary(rs.map(r => r.usage.input_tokens)) }
  }).filter(Boolean)
  const spansRecs = ok.filter(r => r.phase === 'b')
  R.latencyVsQuestions = spansRecs.length > 2 ? ols(spansRecs.map(r => r.questions), lat(spansRecs)) : null
  const phasesUsd = [...groupBy(records.filter(r => r.ok), r => r.phase)].map(([phase, xs]) => ({ phase, requests: xs.length, inputTokens: xs.reduce((a, r) => a + r.usage.input_tokens, 0), usd: xs.reduce((a, r) => a + r.usage.input_tokens, 0) * USD_PER_M_INPUT / 1e6 }))
  R.cost = { phases: phasesUsd, totalUsd: phasesUsd.reduce((a, p) => a + p.usd, 0), models: [...new Set(records.filter(r => r.ok).map(r => r.model))], perShipRequestUsd: spansRecs.length ? mean(spansRecs.map(r => r.usage.input_tokens)) * USD_PER_M_INPUT / 1e6 : null }
  R.failures = records.filter(r => !r.ok).map(r => ({ id: r.id, status: r.status, error: r.error }))
  R.retried = records.filter(r => r.retries?.length).length
  R.missingAnswers = records.filter(r => r.ok && ['b', 'bparts', 'brev'].includes(r.phase)).filter(r => Object.keys(r.answers).length !== r.questions).length

  // 誕生日の付箋
  const bd = noteById(fx, 'birthday'), bdItem = it.pooled.find(x => x.note.id === 'birthday')
  if (bdItem) {
    const sel = new Set(selectSpans(bd.spans, bdItem.v, rp)), selWords = new Set(selectSpans(bd.spans, bdItem.v, { ...rp, margin: Infinity }))
    const ks = kinds.filter(k => k.note === 'birthday')
    R.birthday = {
      selected: [...sel].map(i => bd.spans[i].surface), selectedWordsOnly: [...selWords].map(i => bd.spans[i].surface),
      selectedByMargin: Object.fromEntries([0.1, 0.05, 0.03, 0.02, 0, -0.1].map(m => [m, selectSpans(bd.spans, bdItem.v, { ...rp, margin: m }).map(i => bd.spans[i].surface)])),
      selectedByCapMargin: Object.fromEntries(CAPS.flatMap(c => [0.05, 0.03, 0].map(m => [`cap${c} margin${m}`, selectSpans(bd.spans, bdItem.v, { ...rp, cap: c, margin: m }).map(i => bd.spans[i].surface)]))),
      spans: bd.spans.map((s, i) => {
        const xs = bdItem.reps.map(r => r[i])
        return { surface: s.surface, merged: s.merged, label: bd.underline.includes(s.surface) ? 'underline' : bd.unsure.includes(s.surface) ? 'unsure' : '-', mean: bdItem.v[i], min: Math.min(...xs), max: Math.max(...xs), selected: sel.has(i), selectedWordsOnly: selWords.has(i), kind: ks.find(k => k.surface === s.surface) }
      }),
    }
  }

  // 追加（結果を見たあとに足した記述統計。protocol の規則には入っていない）
  const ex = R.extra = {}
  const fixed = (cap, margin = rp.margin) => spanChooser({ t: rp.t, cap, margin })
  const tunedAt = cap => spanChooser({ t: R.tuned[cap].mergeParams.t, cap, margin: R.tuned[cap].mergeParams.margin === 'inf' ? Infinity : R.tuned[cap].mergeParams.margin })
  ex.capFixedParams = Object.fromEntries(SET_NAMES.map(s => [s, { '4vs3': pairedDelta(it[s], fixed(4), fixed(3)), '5vs4': pairedDelta(it[s], fixed(5), fixed(4)), '5vs3': pairedDelta(it[s], fixed(5), fixed(3)) }]))
  ex.capTunedParams = Object.fromEntries(SET_NAMES.map(s => [s, { '4vs3': pairedDelta(it[s], tunedAt(4), tunedAt(3)), '5vs4': pairedDelta(it[s], tunedAt(5), tunedAt(4)), '5vs3': pairedDelta(it[s], tunedAt(5), tunedAt(3)) }]))
  ex.marginVsRecommended = Object.fromEntries(SET_NAMES.map(s => [s, Object.fromEntries(MARGINS.filter(m => m !== rp.margin).map(m => [mlabel(m), pairedDelta(it[s], fixed(recCap), fixed(recCap, m))]))]))
  ex.selectedPerNote = Object.fromEntries(CAPS.map(c => [c, Object.fromEntries(SET_NAMES.map(s => { const x = R.tuned[c].merge[s].strict; return [s, (x.tp + x.fp) / R.labels[s].notes] }))]))
  ex.goldPerNote = Object.fromEntries(SET_NAMES.map(s => [s, R.labels[s].underlineUnits / R.labels[s].notes]))
  const paramsOf = c => ({ t: R.tuned[c].mergeParams.t, cap: c, margin: R.tuned[c].mergeParams.margin === 'inf' ? Infinity : R.tuned[c].mergeParams.margin })
  ex.limiterByCap = Object.fromEntries(CAPS.map(c => [c, Object.fromEntries(SET_NAMES.map(s => [s, { ...limiterB(it[s], paramsOf(c)), notesAtCap: it[s].filter(x => selectSpans(x.note.spans, x.v, paramsOf(c)).length >= c).length }]))]))
  // 1回だけ送ったとき（出荷する形）の F1。3回の平均ではなく、周回ごと
  const nRep = Math.min(...it.pooled.map(x => x.reps.length))
  const perRepeat = (s, params) => Array.from({ length: nRep }, (_, r) => tallySpans(it[s].map(x => ({ note: x.note, v: x.reps[r] })), spanChooser(params)).f1)
  ex.singleShotF1 = Object.fromEntries(SET_NAMES.map(s => [s, {
    recommended: perRepeat(s, rp), margin0: perRepeat(s, { ...rp, margin: 0 }), wordsOnly: perRepeat(s, { ...rp, margin: Infinity }),
    meanOfRepeatsRecommended: tallySpans(it[s], spanChooser(rp)).f1,
  }]))
  // B の値の分布（正解の単位と、それ以外）。t が効く範囲か
  const gv = [], nv = []
  for (const x of it.pooled) { const { gold, unsure, overlapOnly } = goldOf(x.note); x.note.spans.forEach((sp, i) => { if (overlapOnly.has(i) || unsure.has(i)) return; (gold.has(i) ? gv : nv).push(x.v[i]) }) }
  const dist2 = xs => ({ n: xs.length, mean: mean(xs), p10: quantile(xs, 0.1), p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), ge50: xs.filter(v => v >= 0.5).length / xs.length, ge70: xs.filter(v => v >= 0.7).length / xs.length, ge80: xs.filter(v => v >= 0.8).length / xs.length })
  ex.valueDist = { gold: dist2(gv), nonGold: dist2(nv) }
  // 句の判定が3回の繰り返しで安定か（句が語に勝つかの符号）。d の AUC の区間
  ex.decisionStability = Object.fromEntries([0, 0.05].map(m => {
    let same = 0, n = 0
    for (const x of it.pooled) for (const ch of chainInfos(x.note)) {
      if (!decisionTypes.includes(ch.type)) continue
      n++; if (new Set(x.reps.map(v => mergeWins(ch.span, x.note.spans, v, m))).size === 1) same++
    }
    return [m, { same, n }]
  }))
  // protocol の margin の格子（0.05 の次が 0）の間の点。結果を見て足したので、格子とは別に出す
  ex.betweenMargins = Object.fromEntries([0.03, 0.02, 0.01].map(m => {
    let same = 0, n = 0
    for (const x of it.pooled) for (const ch of chainInfos(x.note)) {
      if (!decisionTypes.includes(ch.type)) continue
      n++; if (new Set(x.reps.map(v => mergeWins(ch.span, x.note.spans, v, m))).size === 1) same++
    }
    return [m, {
      decision: Object.fromEntries(SET_NAMES.map(s => [s, chainDecision(it[s], m)])),
      f1: Object.fromEntries(SET_NAMES.map(s => [s, tallySpans(it[s], fixed(recCap, m)).f1])),
      vsRecommended: Object.fromEntries(SET_NAMES.map(s => [s, pairedDelta(it[s], fixed(recCap, m), fixed(recCap))])),
      stable: { same, n },
    }]
  }))
  const ev = R.merge.chains.filter(c => c.d !== null && decisionTypes.includes(c.label))
  const aucD = es => { const P = es.filter(e => e.label === 'merged').map(e => e.d), N = es.filter(e => e.label === 'both').map(e => e.d); if (!P.length || !N.length) return null; let a = 0; for (const p of P) for (const n of N) a += p > n ? 1 : p === n ? 0.5 : 0; return a / (P.length * N.length) }
  ex.dAucCi = Object.fromEntries(SET_NAMES.map(s => { const es = ev.filter(e => s === 'pooled' || e.set === s); return [s, { auc: aucD(es), ci: bootstrap(es, aucD), n: es.length }] }))
  ex.alwaysMergeDecisionAccuracy = Object.fromEntries(SET_NAMES.map(s => { const es = ev.filter(e => s === 'pooled' || e.set === s); return [s, { ok: es.filter(e => e.label === 'merged').length, n: es.length }] }))
  return R
}

export function renderB(R) {
  const L = []
  const h = s => L.push(`\n## ${s}\n`)
  const SN = { old: '旧20件', heldout: '新20件（判断に使う）', pooled: '40件' }
  const ci = o => o ? `${f3(o.auc)} [${f3(o.ci.lo)}, ${f3(o.ci.hi)}]` : '-'
  const dd = o => `${f3(o.diff)} [${f3(o.ci.lo)}, ${f3(o.ci.hi)}]`
  const rec = R.recommended
  L.push(`# Jev 計測 B: 語と句の下線 (${R.meta.startedAt ?? ''})`, '', `records: ${R.records}, model: ${R.cost.models.join(', ')}, fixture sha256: ${R.meta.fixtureSha256 ?? '?'}, labelsSha256: ${R.meta.labelsSha256 ?? '?'}, questionSha256: ${R.meta.questionSha256 ?? '?'}`)
  L.push('', `推奨（protocol の規則）: cap ${rec.cap}、t ${rec.t}、margin ${rec.margin}。cap ごとの heldout の strict F1（old で選んだ値）: ${Object.entries(rec.heldoutF1ByCap).map(([c, f]) => `cap${c} ${f2(f)}`).join('、')}`)

  h('ラベル')
  L.push(table(['set', '付箋', '語', 'spans', '句', 'underline 単位', 'うち句', 'unsure', '下線なしの付箋', 'cap3 超', 'cap4 超', 'cap5 超', '単位数の分布 (単位数:付箋数)', '再現率の上限 cap3/4/5'],
    SET_NAMES.map(s => { const l = R.labels[s]; return [SN[s], l.notes, l.words, l.spans, l.mergedSpans, l.underlineUnits, l.underlineMergedUnits, l.unsure, l.notesWithoutUnderline, l.overCap[3], l.overCap[4], l.overCap[5], l.underlineHistogram.map(([k, v]) => `${k}:${v}`).join(' '), CAPS.map(c => pct(l.recallCeiling[c].rate)).join(' / ')] })))
  L.push('', `2語の「AのB」の正解の種類（merged: 正解が句 / both: 両方の語 / one: 片方の語 / none: 無し）と 3語以上の列: ${SET_NAMES.map(s => `${SN[s]} ${JSON.stringify(R.labels[s].chainTypes)}`).join('、')}`)

  h('ぶれ（B を同じ質問で3回）')
  L.push(`質問 ${R.noise.n} 個。3回の幅: 中央値 ${f2(R.noise.p50)}、p95 ${f2(R.noise.p95)}、最大 ${f2(R.noise.max)}、幅 0 が ${R.noise.zero}、幅 0.1 以上が ${R.noise.ge010}。`)

  h('AUC（B の値と正解の単位。付箋を再標本化した 95% 区間）')
  L.push(table(['set', 'spans 全部 (spans 送信)', '語のみ (spans 送信)', '語のみ (parts 送信)', '句のみ', 'unsure=付ける', 'unsure=数えない'],
    SET_NAMES.map(s => { const a = R.auc[s]; return [SN[s], ci(a.spans), ci(a.wordsInSpansRequest), ci(a.wordsInPartsRequest), ci(a.mergedOnly), f3(a.unsurePositive), f3(a.unsureDrop)] })))

  h('cap と閾値・margin（old で選んだ値を、そのまま各 set に当てた strict の適合率 / 再現率 / F1。括弧は lenient の F1）')
  for (const cap of CAPS) {
    const T = R.tuned[cap]
    L.push(`### cap ${cap}: 句あり (t ${T.mergeParams.t}, margin ${T.mergeParams.margin})、語だけ (t ${T.wordsParams.t})。heldout 自身で選び直すと 句あり t ${T.heldoutOwnMerge.t} margin ${T.heldoutOwnMerge.margin} F1 ${f2(T.heldoutOwnMerge.f1)}、語だけ t ${T.heldoutOwnWords.t} F1 ${f2(T.heldoutOwnWords.f1)}（標本内。参考）`, '')
    L.push(table(['set', '句あり', '語だけ', '現行ルール rank', 'F1 の上限（完璧に選べたとき）'],
      SET_NAMES.map(s => [SN[s], `${prfCell(T.merge[s].strict)} (${f2(T.merge[s].lenient.f1)})`, `${prfCell(T.words[s].strict)} (${f2(T.words[s].lenient.f1)})`, `${prfCell(T.rank[s].strict)} (${f2(T.rank[s].lenient.f1)})`, f2(T.f1Ceiling[s])])))
    L.push('', `F1 の差（付箋を再標本化した 95% 区間。0 を含めば区別できない）: ` + ['old', 'heldout', 'pooled'].map(s => `${SN[s]}: 句あり-語だけ ${dd(T.mergeVsWords[s])}、句あり-rank(strict) ${dd(T.mergeVsRank[s].strict)}、句あり-rank(lenient) ${dd(T.mergeVsRank[s].lenient)}、語だけ-rank(strict) ${dd(T.wordsVsRank[s])}`).join('; '), '')
  }
  L.push('unsure の扱いを変えたときの F1（句あり。付けない側 / 数えない / 付ける側）:', '', table(['cap', ...SET_NAMES.map(s => SN[s])], CAPS.map(c => [c, ...SET_NAMES.map(s => `${f2(R.tuned[c].merge[s].strict.f1)} / ${f2(R.tuned[c].merge[s].drop.f1)} / ${f2(R.tuned[c].merge[s].positive.f1)}`)])))

  h('句（margin ごと。推奨の cap・t で）')
  L.push('判定 = 2語の句のうち、正解が「句」か「両方の語」のものについて、句が語に勝つかの正答率（t と cap に依らない）。end = 選択まで通して、その列の選択が正解と一致した数（種類ごと）。', '')
  L.push(table(['margin', '判定 old', '判定 heldout', '判定 pooled', 'F1 old', 'F1 heldout', 'F1 pooled', 'end heldout (merged / both / one / none)'],
    R.merge.byMargin.map(m => { const e = m.end.heldout, c = k => e[k] ? `${e[k].matched}/${e[k].total}` : '-'; return [m.margin, ...['old', 'heldout', 'pooled'].map(s => `${m.decision[s].ok}/${m.decision[s].n}`), ...['old', 'heldout', 'pooled'].map(s => f2(m.f1AtRecommended[s])), `${c('merged')} / ${c('both')} / ${c('one')} / ${c('none')}`] })))
  const dm = R.merge.d
  L.push('', `d = 句の値 - 部分の語の最大値（2語の句）。種類ごとの平均 [最小, 最大] (n)。merged と both を分けられるかの AUC: ${SET_NAMES.map(s => `${SN[s]} ${f3(dm[s].aucMergedVsBoth)}`).join('、')}`, '')
  L.push(table(['set', 'merged（正解が句）', 'both（両方の語）', 'one（片方）', 'none'], SET_NAMES.map(s => [SN[s], ...['merged', 'both', 'one', 'none'].map(k => { const o = dm[s][k]; return o.n ? `${f2(o.mean)} [${f2(o.min)}, ${f2(o.max)}] (${o.n})` : '-' })])))
  L.push('', '列ごとの結果（推奨の cap・t・margin。値は3回の平均）:', '')
  L.push(table(['set', '付箋', '列', '正解の種類', '正解', '選択', '一致', 'd', '値'], R.merge.chains.map(c => [c.set, c.note, c.chain, c.label, c.goldIn.join(' / ') || '-', c.selected.join(' / ') || '-', c.matched ? 'o' : 'x', c.d === null ? '-' : f2(c.d), Object.entries(c.values).map(([k, v]) => `${k} ${f2(v)}`).join(', ')])))

  h('安定性（3回の選択が同じか。推奨のパラメータ）')
  for (const s of ['old', 'heldout']) {
    const st = R.stability[s]
    L.push(`- ${SN[s]}: 規則の選択が3回とも同じ ${st.rule.same}/${st.rule.notes}（平均 Jaccard ${f2(st.rule.meanJaccard)}）。閾値なしの上位 k が3回とも同じ: ${CAPS.map(k => `k=${k} ${st.topK[k].same}/${st.topK[k].notes}`).join('、')}`)
  }

  h('取りこぼしと誤りの理由（推奨のパラメータ、strict）')
  L.push(table(['set', '正解', '当たり', '値が t 未満', '他の選択と重なる', 'cap で溢れた', '選択', '誤り: unsure', '誤り: 粒度違い', '誤り: 負'],
    SET_NAMES.map(s => { const o = R.limiter[s]; return [SN[s], o.gold, o.hit, o.missBelowT, o.missOverlap, o.missCap, o.selected, o.fpUnsure, o.fpGranularity, o.fpNegative] })))

  h('追加（結果を見たあとに足した記述統計。protocol の規則には入っていない）')
  const ex = R.extra
  L.push(`- 選択数 / 付箋（句あり、old で選んだ値）: ${CAPS.map(c => `cap${c} ${SET_NAMES.map(s => `${SN[s]} ${f2(ex.selectedPerNote[c][s])}`).join(' / ')}`).join('、')}。正解の単位 / 付箋: ${SET_NAMES.map(s => `${SN[s]} ${f2(ex.goldPerNote[s])}`).join(' / ')}`)
  L.push(`- cap の比較（t ${rec.t}、margin ${rec.margin} に固定。F1 の差と 95% 区間）: ${['old', 'heldout', 'pooled'].map(s => `${SN[s]}: 4-3 ${dd(ex.capFixedParams[s]['4vs3'])}、5-4 ${dd(ex.capFixedParams[s]['5vs4'])}、5-3 ${dd(ex.capFixedParams[s]['5vs3'])}`).join('; ')}`)
  L.push(`- cap の比較（cap ごとに old で選んだ値）: ${['old', 'heldout', 'pooled'].map(s => `${SN[s]}: 4-3 ${dd(ex.capTunedParams[s]['4vs3'])}、5-4 ${dd(ex.capTunedParams[s]['5vs4'])}、5-3 ${dd(ex.capTunedParams[s]['5vs3'])}`).join('; ')}`)
  L.push(`- margin の比較（推奨 margin ${rec.margin} - 他の margin の F1 差と 95% 区間。cap ${rec.cap}、t ${rec.t}）:`)
  for (const s of SET_NAMES) L.push(`  - ${SN[s]}: ${Object.entries(ex.marginVsRecommended[s]).map(([m, o]) => `margin ${m} ${dd(o)}`).join('、')}`)
  L.push(`- 1回だけ送ったとき（出荷する形）の F1（周回ごと。推奨 / margin 0 / 語だけ。括弧は3回の平均を使った推奨の F1）: ${SET_NAMES.map(s => { const o = ex.singleShotF1[s]; const r = a => `${f2(Math.min(...a))}-${f2(Math.max(...a))}`; return `${SN[s]} ${r(o.recommended)} / ${r(o.margin0)} / ${r(o.wordsOnly)} (${f2(o.meanOfRepeatsRecommended)})` }).join('; ')}`)
  L.push(`- 格子の間の margin（結果を見て足した点。cap ${rec.cap}、t ${rec.t}。F1 は old / heldout / pooled、差は推奨 margin ${rec.margin} との差の 95% 区間（pooled）、判定は pooled の列の正答率、安定は3回とも同じだった列）:`, '')
  L.push(table(['margin', 'F1 old / heldout / pooled', '推奨との差 pooled', '判定 old / heldout / pooled', '判定が3回とも同じ'], Object.entries(ex.betweenMargins).map(([m, o]) => [m, SET_NAMES.map(s => f2(o.f1[s])).join(' / '), dd(o.vsRecommended.pooled), SET_NAMES.map(s => `${o.decision[s].ok}/${o.decision[s].n}`).join(' / '), `${o.stable.same}/${o.stable.n}`])), '')
  L.push('- cap ごとの取りこぼし（cap ごとに old で選んだ値）。cap で溢れた = 値は t 以上なのに、cap に達していて選ばれなかった正解の単位:', '')
  L.push(table(['cap', 'set', '正解', '当たり', '値が t 未満', '他の選択と重なる', 'cap で溢れた', 'cap に達した付箋'], CAPS.flatMap(c => ['heldout', 'pooled'].map(s => { const o = ex.limiterByCap[c][s]; return [c, SN[s], o.gold, o.hit, o.missBelowT, o.missOverlap, o.missCap, `${o.notesAtCap}/${R.labels[s].notes}`] }))), '')
  const vd = ex.valueDist
  L.push(`- B の値の分布（正解の単位 n=${vd.gold.n} / それ以外 n=${vd.nonGold.n}。unsure と、正解と重なる別の粒度の spans は除く）: 平均 ${f2(vd.gold.mean)} / ${f2(vd.nonGold.mean)}、p10 ${f2(vd.gold.p10)} / ${f2(vd.nonGold.p10)}、p50 ${f2(vd.gold.p50)} / ${f2(vd.nonGold.p50)}、p90 ${f2(vd.gold.p90)} / ${f2(vd.nonGold.p90)}。0.5 以上の割合 ${pct(vd.gold.ge50)} / ${pct(vd.nonGold.ge50)}、0.7 以上 ${pct(vd.gold.ge70)} / ${pct(vd.nonGold.ge70)}、0.8 以上 ${pct(vd.gold.ge80)} / ${pct(vd.nonGold.ge80)}`)
  L.push(`- 句が語に勝つかの判定が3回とも同じ（40件、正解が句か両方の語の列 ${ex.decisionStability[0].n} 個）: margin 0 で ${ex.decisionStability[0].same} 個、margin 0.05 で ${ex.decisionStability[0.05].same} 個`)
  L.push(`- d で「正解が句」と「正解が両方の語」を分ける AUC（列を再標本化した 95% 区間）: ${SET_NAMES.map(s => `${SN[s]} ${f3(ex.dAucCi[s].auc)} [${f3(ex.dAucCi[s].ci.lo)}, ${f3(ex.dAucCi[s].ci.hi)}] (n=${ex.dAucCi[s].n})`).join('、')}。「いつも句を選ぶ」の判定の正答率: ${SET_NAMES.map(s => `${SN[s]} ${ex.alwaysMergeDecisionAccuracy[s].ok}/${ex.alwaysMergeDecisionAccuracy[s].n}`).join('、')}`)

  h('確認: 別のものを測っていないか')
  const c = R.contamination
  L.push(`- 句を足しても語の値が動かないか: parts 送信と spans 送信の、語の値の平均絶対差 ${f3(c.wordsMeanAbsDiffPartsVsSpans)}（n=${c.n}）。同じ送信の3回どうしの差は ${f3(c.wordsMeanAbsDiffBetweenRepeats)}。`)
  L.push(`- 語だけを送った値で語だけの規則を当てた F1（推奨 cap）: ${SET_NAMES.map(s => `${SN[s]} ${f2(c.f1PartsRequestWordsOnly[s])}`).join('、')}`)
  L.push(`- 並びを逆にして送ったとき（位置の偏り）: ${R.reverse.map(r => `${r.note} 平均差 ${f3(r.meanAbsDiff)} 最大差 ${f2(r.maxAbsDiff)} 選択${r.sameSelection ? '同じ' : '違う'}`).join('、') || '-'}`)
  L.push(`- 失敗 ${R.failures.length} 件 ${JSON.stringify(R.failures)}、リトライした記録 ${R.retried} 件、答えが欠けた記録 ${R.missingAnswers} 件`)

  h('kind と shape（spans 送信）')
  const k = R.kindShape
  L.push(`kind の分布（全 spans）: ${JSON.stringify(k.kindDist)}`, `kind の分布（正解の単位）: ${JSON.stringify(k.kindDistGold)}`, `kind が3回とも同じ: 全 ${k.kindUnanimous.all}/${k.kindUnanimous.of}、正解の単位 ${k.kindUnanimousGold.all}/${k.kindUnanimousGold.of}、句 ${k.kindUnanimousMerged.all}/${k.kindUnanimousMerged.of}。確信度 p50 ${f2(k.kindConfidence?.p50)} min ${f2(k.kindConfidence?.min)}`, `shape の分布: ${JSON.stringify(k.shapeDist)}、3回とも同じ ${k.shapeUnanimous.all}/${k.shapeUnanimous.of}`)

  h('遅延と費用')
  L.push(table(['phase', 'n', 'p50', 'mean', 'p95', 'max', '>1000 ms', '質問 p50 (max)', 'input tok p50 (max)'], R.latency.map(g => [g.phase, g.n, ms(g.p50), ms(g.mean), ms(g.p95), ms(g.max), g.over1000, `${g.questions.p50} (${g.questions.max})`, `${ms(g.inputTokens.p50)} (${ms(g.inputTokens.max)})`])))
  if (R.latencyVsQuestions) L.push('', `spans 送信の遅延 ~ 質問数: ${f2(R.latencyVsQuestions.slope)} ms/質問、切片 ${ms(R.latencyVsQuestions.intercept)} ms、R2 ${f2(R.latencyVsQuestions.r2)}`)
  L.push('', table(['phase', 'requests', 'input tok', 'USD'], R.cost.phases.map(p => [p.phase, p.requests, p.inputTokens, p.usd.toFixed(5)])), '', `合計 $${R.cost.totalUsd.toFixed(5)}。出荷する形（spans 送信）1リクエスト平均 $${(R.cost.perShipRequestUsd ?? 0).toFixed(6)}。`)

  h('誕生日の付箋')
  if (R.birthday) {
    L.push(`推奨のパラメータでの下線: ${R.birthday.selected.join(' / ')}。語だけの規則（同じ cap・t）: ${R.birthday.selectedWordsOnly.join(' / ')}`, '', `margin を変えたとき（推奨の cap・t）: ${Object.entries(R.birthday.selectedByMargin).map(([m, xs]) => `margin ${m}: ${xs.join(' / ')}`).join('; ')}`, '', `cap と margin を変えたとき（t は推奨）: ${Object.entries(R.birthday.selectedByCapMargin).map(([k, xs]) => `${k}: ${xs.join(' / ')}`).join('; ')}`, '')
    L.push(table(['span', '句', '正解', 'B 平均 [最小-最大]', '選択', '語だけの規則で選択', 'kind (votes)'], R.birthday.spans.map(s => [s.surface, s.merged ? 'yes' : '', s.label, `${f2(s.mean)} [${f2(s.min)}-${f2(s.max)}]`, s.selected ? 'o' : '', s.selectedWordsOnly ? 'o' : '', s.kind ? `${s.kind.choice} (${s.kind.votes}/${s.kind.of})` : '-'])))
  }
  return L.join('\n') + '\n'
}

function analyzeBCommand(opt) {
  const fxPath = resolve(opt.fixture), out = resolve(opt.out)
  const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'))
  const fx = loadFixture(fxPath)
  if (meta.labelsSha256 !== labelsHash(fx)) throw new Error('ラベルが run のときと違う（labelsSha256 不一致）。結果を報告できない')
  if (meta.questionSha256 !== questionHash()) throw new Error('B の問いの文言が run のときと違う（questionSha256 不一致）')
  if (meta.fixtureSha256 !== sha256(fxPath)) console.error('警告: fixture のファイルが run のときと違う（sha256 不一致。ラベルと問いは一致）')
  const R = analyzeB(fx, readJsonl(join(out, 'raw.jsonl')), meta)
  writeFileSync(join(out, 'report-b.json'), JSON.stringify(R, null, 2))
  writeFileSync(join(out, 'report-b.md'), renderB(R))
  console.log(`wrote ${join(out, 'report-b.md')} and report-b.json`)
}

/* ============ preview / analyze ============ */
function previewCommand(opt) {
  const fx = loadFixture(resolve(opt.fixture)), note = noteById(fx, opt.note)
  const { body } = buildRequest(note, opt.variant, { reverse: opt.reverse })
  console.log(JSON.stringify(body, null, 2))
  console.error(`questions: ${Object.keys(body.questions).length}, bytes: ${Buffer.byteLength(JSON.stringify(body))}`)
}
function analyzeCommand(opt) {
  const fxPath = resolve(opt.fixture), out = resolve(opt.out)
  const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'))
  const fx = loadFixture(fxPath)
  if (meta.fixtureSha256 !== sha256(fxPath)) console.error('警告: fixture が run のときと違う（sha256 不一致）')
  const centralPath = opt.central ?? join(dirname(fxPath), 'jev-notes-central.json')
  if (existsSync(centralPath)) {
    const { central } = JSON.parse(readFileSync(centralPath, 'utf8'))
    for (const n of fx.notes) {
      n.central = central[n.id] ?? []
      const surfaces = new Set(n.candidates.map(c => c.surface))
      for (const s of n.central) if (!surfaces.has(s)) throw new Error(`${n.id}: central の「${s}」は候補にない`)
    }
  }
  const R = analyze(fx, readJsonl(join(out, 'raw.jsonl')), meta)
  writeFileSync(join(out, 'report.json'), JSON.stringify(R, null, 2))
  writeFileSync(join(out, 'report.md'), renderMarkdown(R))
  console.log(`wrote ${join(out, 'report.md')} and report.json`)
}

/* ============ selftest ============ */
async function selftest() {
  const approx = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} != ${b}`)
  const fx = loadFixture(join(HERE, 'jev-notes.json'))

  // 集計の部品
  approx(auc([{ note: { candidates: [{ surface: 'a' }, { surface: 'b' }, { surface: 'c' }, { surface: 'd' }], underline: ['a', 'c'], unsure: [] }, v: [0.9, 0.8, 0.3, 0.2] }]), 0.75, 'auc')
  approx(auc([{ note: { candidates: [{ surface: 'a' }, { surface: 'b' }], underline: ['a'], unsure: [] }, v: [0.5, 0.5] }]), 0.5, 'auc tie')
  approx(quantile([1, 2, 3, 4, 5], 0.5), 3, 'p50'); approx(quantile([1, 2, 3, 4, 5], 0.95), 4.8, 'p95')
  const n4 = { candidates: ['a', 'b', 'c', 'd'].map(surface => ({ surface })), underline: ['a'], unsure: ['d'] }
  assert.deepEqual([...pick(n4, [0.9, 0.8, 0.7, 0.6], { type: 'capped', t: 0.5 })], ['a', 'b', 'c'])
  assert.deepEqual([...pick(n4, [0.9, 0.8, 0.7, 0.6], { type: 'threshold', t: 0.5 })], ['a', 'b', 'c', 'd'])
  assert.deepEqual([...pick(n4, [0.5, 0.5, 0.5, 0.5], { type: 'top' })], ['a', 'b', 'c'], '同点は出現順')
  assert.deepEqual([...pick(n4, [0.1, 0.9, 0.2, 0.3], { type: 'capped', t: 0.25 })], ['b', 'd'], '閾値未満は上限3つに満たなくても入れない')
  const it = [{ note: n4, v: [0.9, 0.8, 0.7, 0.6] }], sel = x => new Set(['a', 'b', 'd'])
  assert.deepEqual([tally(it, sel).tp, tally(it, sel).fp, tally(it, sel).fn], [1, 2, 0], 'unsure=negative')
  assert.deepEqual([tally(it, sel, 'positive').tp, tally(it, sel, 'positive').fp], [2, 1], 'unsure=positive')
  assert.deepEqual([tally(it, sel, 'drop').tp, tally(it, sel, 'drop').fp], [1, 1], 'unsure=drop')

  // 質問の組み立て: 候補ごとに自分の添字と表記だけを指す
  const bd = noteById(fx, 'birthday'), req = buildRequest(bd, 'full')
  const n = bd.candidates.length
  assert.equal(Object.keys(req.body.questions).length, 3 * n + 1)
  bd.candidates.forEach((c, i) => {
    for (const name of ['impact', 'ambiguity', 'kind']) {
      const q = req.body.questions[`${name}_${i}`]
      assert.ok(q.instructions.includes(`state.candidates[${i}]`) && q.instructions.includes(`「${c.surface}」`), `${name}_${i}`)
      assert.ok(!q.instructions.includes(`candidates[${(i + 1) % n}]`), `${name}_${i} が他の添字を指している`)
    }
  })
  assert.equal(req.body.questions.impact_0.type, 'noul'); assert.equal(req.body.questions.kind_0.type, 'choice')
  assert.deepEqual(Object.keys(req.body.questions.kind_0.criteria), Object.keys(KINDS))
  assert.equal(buildRequest(bd, 'score').body.questions.impactScore_0.criteria.length, SCORE_LEVELS)
  assert.deepEqual(buildRequest(bd, 'full', { reverse: true }).surfaces, bd.candidates.map(c => c.surface).reverse())
  assert.equal(Object.keys(buildScalingQuestions(bd, 64).body.questions).length, 64)
  assert.ok(JSON.stringify(req.body).length < 60_000)

  // 偽のサーバー: 429 を1回返してから成功。キーは送られるが、記録には残らない
  const seen = []
  const server = createServer((rq, rs) => {
    let b = ''; rq.on('data', d => b += d); rq.on('end', () => {
      seen.push({ auth: rq.headers.authorization, body: JSON.parse(b) })
      if (seen.length === 1) { rs.writeHead(429, { 'retry-after': '0' }); rs.end('{"error":"slow down"}'); return }
      rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ model: 'jev-fake', answers: {}, usage: { input_tokens: 10, output_tokens: 1 } }))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/systemone`
  const res = await post({ model: MODEL, state: {}, questions: {} }, { endpoint, key: 'test-key', sleep: async () => {} })
  assert.equal(res.ok, true); assert.equal(res.tries, 2); assert.equal(res.retries[0].status, 429)
  assert.equal(seen[0].auth, 'Bearer test-key')
  assert.ok(!JSON.stringify(res).includes('test-key'), 'キーが結果に入っている')
  const bad = await post({}, { endpoint: 'http://127.0.0.1:1/v1/systemone', key: 'test-key', maxTries: 2, sleep: async () => {}, timeoutMs: 2000 })
  assert.equal(bad.ok, false); assert.equal(bad.tries, 2)
  server.close()

  // 分析の通し: 下線の語に高い値を返す偽の Jev なら AUC が 1、逆なら 0。位置の対応（逆順の記録）も崩れない
  const fake = (oracle, rev = false) => {
    const recs = []
    for (const note of fx.notes) for (let r = 1; r <= 3; r++) {
      const surfaces = note.candidates.map(c => c.surface); if (rev) surfaces.reverse()
      const answers = {}
      surfaces.forEach((s, i) => {
        const hi = note.underline.includes(s) === oracle
        answers[`impact_${i}`] = { type: 'noul', noul: hi ? 0.9 : 0.1 }; answers[`ambiguity_${i}`] = { type: 'noul', noul: 0.5 }
        answers[`kind_${i}`] = { type: 'choice', choice: '場所', confidence: 0.9, probabilities: {} }
      })
      answers.shape = { type: 'choice', choice: '短い提案', confidence: 0.9, probabilities: {} }
      recs.push({ id: `${note.id}${r}`, phase: 'main', variant: 'full', noteId: note.id, repeat: r, extra: '', candidates: surfaces, ok: true, answers, latencyMs: 100 + r, questions: 1, usage: { input_tokens: 100, output_tokens: 10 }, model: 'jev-fake', requestBytes: 1000, retries: [] })
    }
    return recs
  }
  const good = analyze(fx, fake(true)), goodRev = analyze(fx, fake(true, true)), badR = analyze(fx, fake(false))
  approx(good.accuracy.impact.auc.negative, 1, 'oracle auc'); approx(goodRev.accuracy.impact.auc.negative, 1, 'oracle auc (逆順の記録)')
  approx(badR.accuracy.impact.auc.negative, 0, 'anti-oracle auc')
  approx(good.accuracy.impact.threshold.find(x => x.t === 0.5).capped.f1, 1, 'oracle capped f1')
  assert.equal(good.stability.impact.range.max, 0)
  assert.equal(good.accuracy.impact.bestT, 0.8, '同点なら高い閾値')
  assert.equal(good.kindShape.shapeDist['短い提案'], fx.notes.length)
  assert.ok(renderMarkdown(good).includes('誕生日の付箋'), 'レポートが描画できる')

  // 句の候補（tools/spans.mjs）: 「の」（連体化）1トークンだけでつながる語を窓にする
  const tk = (s, p = '名詞', d1 = '一般') => ({ s, p, d1 })
  const no = tk('の', '助詞', '連体化')
  const text3 = '父の還暦祝いの夕食と、乾杯の挨拶の原稿を決めてほしい'
  const toks3 = [tk('父'), no, tk('還暦祝い'), no, tk('夕食'), tk('と', '助詞', '並立助詞'), tk('、', '記号', '読点'), tk('乾杯'), no, tk('挨拶'), no, tk('原稿'), tk('を', '助詞', '格助詞'), tk('決め', '動詞', '自立'), tk('て', '助詞', '接続助詞'), tk('ほしい', '形容詞', '自立')]
  const at3 = s => text3.indexOf(s)
  const cands3 = ['還暦祝い', '夕食', '乾杯', '挨拶', '原稿'].map(s => ({ surface: s, start: at3(s), end: at3(s) + s.length, kind: 'noun' }))
  const sp3 = mergeSpans(text3, cands3, toks3)
  assert.deepEqual(sp3.filter(s => s.merged).map(s => s.surface), ['還暦祝いの夕食', '乾杯の挨拶', '乾杯の挨拶の原稿', '挨拶の原稿'], '1語の名詞（父）は候補でないので句の頭にならない。「と、」を挟む語はつなげない。3語の列は窓を全部作る')
  assert.deepEqual(sp3.filter(s => !s.merged).map(s => s.surface), cands3.map(c => c.surface), '語の候補は変えない')
  assert.ok(sp3.every((s, i) => i === 0 || sp3[i - 1].start < s.start || (sp3[i - 1].start === s.start && sp3[i - 1].end <= s.end)), 'start 昇順、同じなら end 昇順')
  assert.equal(mergeSpans('京都の宿', [{ surface: '京都', start: 0, end: 2, kind: 'proper' }], [tk('京都', '名詞', '固有名詞'), no, tk('宿')]).length, 1, '片方が候補でなければ句を作らない')
  assert.deepEqual(chainsOf(sp3).map(c => [c.span.surface, c.parts.length, c.windows.length]), [['還暦祝いの夕食', 2, 1], ['乾杯の挨拶の原稿', 3, 3]])

  // 選択: 句は、部分の語より margin を超えて高いときだけ選ばれる。語だけ（margin Infinity）なら句は使わない
  const spA = [{ surface: '乾杯', start: 0, end: 2, merged: false }, { surface: '乾杯の挨拶', start: 0, end: 5, merged: true }, { surface: '挨拶', start: 3, end: 5, merged: false }, { surface: '献立', start: 8, end: 10, merged: false }]
  const val = [0.9, 0.95, 0.85, 0.7]
  const surfOf = ix => ix.map(i => spA[i].surface)
  assert.deepEqual(surfOf(selectSpans(spA, val, { t: 0.5, cap: 5, margin: 0.04 })), ['乾杯の挨拶', '献立'], '0.05 差は margin 0.04 を超える')
  assert.deepEqual(surfOf(selectSpans(spA, val, { t: 0.5, cap: 5, margin: 0.06 })), ['乾杯', '挨拶', '献立'], '0.05 差は margin 0.06 に届かない')
  assert.deepEqual(surfOf(selectSpans(spA, val, { t: 0.5, cap: 5, margin: Infinity })), ['乾杯', '挨拶', '献立'], '句を使わない')
  assert.deepEqual(surfOf(selectSpans(spA, val, { t: 0.5, cap: 2, margin: 0.04 })), ['乾杯の挨拶', '献立'], '句は1枠')
  assert.deepEqual(surfOf(selectSpans(spA, val, { t: 0.5, cap: 2, margin: Infinity })), ['乾杯', '挨拶'], '語は2枠。cap で献立が溢れる')
  assert.deepEqual(surfOf(selectSpans(spA, val, { t: 0.8, cap: 5, margin: 0.04 })), ['乾杯の挨拶'], '閾値は実際の値に掛ける')
  assert.equal(mergeWins(spA[1], spA, val, 0.04), true); assert.equal(mergeWins(spA[1], spA, val, 0.06), false)

  // 採点: 句が正解のとき、語2つを選ぶと strict では外れ、lenient では当たり。正解の句と重なる語・句は AUC から除く
  const nA = { id: 'x', spans: spA, underline: ['乾杯の挨拶'], unsure: [], candidates: [], baselineRank: ['乾杯', '挨拶', '献立'] }
  const itA = { note: nA, v: [0.99, 0.5, 0.99, 0.1] }
  const strict = tallySpans([itA], () => [0, 2]), lenient = tallySpans([itA], () => [0, 2], { lenient: true })
  assert.deepEqual([strict.tp, strict.fp, strict.fn], [0, 2, 1]); assert.deepEqual([lenient.tp, lenient.fp, lenient.fn], [2, 0, 0])
  approx(aucSpans([itA]), 1, '重なる spans は AUC から除く')
  assert.deepEqual([...goldOf(nA).overlapOnly].sort(), [0, 2])
  const chA = chainInfos(nA); assert.equal(chA.length, 1); assert.equal(chA[0].type, 'merged')
  assert.deepEqual(chainDecision([itA], 0.1), { n: 1, ok: 0, rate: 0 }, '句の値 0.5 は語に勝てない')

  // 問いの例の語は、40件のどの付箋にも含まれない（正解に見える語を問いに書かない）
  const fxB = loadFixture(join(HERE, 'jev-notes-b.json'))
  for (const w of ASSUME_EXAMPLES) for (const n of fxB.notes) assert.ok(!n.text.includes(w), `問いの例「${w}」が付箋 ${n.id} に含まれる`)
  assert.equal(fxB.protocol.labelsSha256, labelsHash(fxB), 'ラベルが protocol.labelsSha256 と違う')
  if (fxB.protocol.questionSha256) assert.equal(fxB.protocol.questionSha256, questionHash(), '問いの文言が protocol.questionSha256 と違う')
  for (const n of fxB.notes) {
    assert.equal(new Set(n.spans.map(s => s.surface)).size, n.spans.length, `${n.id}: spans の表記が重複`)
    const rq = buildRequest(n, 'spans'), rp = buildRequest(n, 'parts')
    assert.deepEqual(rq.surfaces, n.spans.map(s => s.surface)); assert.deepEqual(rp.surfaces, n.candidates.map(c => c.surface))
    assert.equal(Object.keys(rq.body.questions).length, 2 * n.spans.length + 1)
  }
  assert.equal(fxB.notes.filter(n => n.set === 'old').length, 20); assert.equal(fxB.notes.filter(n => n.set === 'heldout').length, 20)

  // 分析の通し（B）: 正解の単位に高い値を返す偽の Jev なら、AUC が 1、正解が句の列は margin 0 で句が勝つ
  const fakeB = (oracle) => {
    const recs = []
    for (const phase of ['b', 'bparts']) for (const note of fxB.notes) for (let r = 1; r <= 3; r++) {
      const list = phase === 'b' ? note.spans : note.spans.filter(s => !s.merged)
      const answers = {}
      list.forEach((s, i) => {
        const hi = note.underline.includes(s.surface) === oracle
        answers[`assume_${i}`] = { type: 'noul', noul: hi ? 0.9 : 0.1 }
        answers[`kind_${i}`] = { type: 'choice', choice: '場所', confidence: 0.9, probabilities: {} }
      })
      answers.shape = { type: 'choice', choice: '短い提案', confidence: 0.9, probabilities: {} }
      recs.push({ id: `${phase}${note.id}${r}`, phase, variant: phase === 'b' ? 'spans' : 'parts', noteId: note.id, repeat: r, extra: '', candidates: list.map(s => s.surface), ok: true, answers, latencyMs: 100 + r, questions: Object.keys(answers).length, usage: { input_tokens: 100, output_tokens: 10 }, model: 'jev-fake', requestBytes: 1000, retries: [] })
    }
    return recs
  }
  const gB = analyzeB(fxB, fakeB(true), { startedAt: 'selftest' }), bB = analyzeB(fxB, fakeB(false))
  approx(gB.auc.pooled.spans.auc, 1, 'oracle auc (B)'); approx(bB.auc.pooled.spans.auc, 0, 'anti-oracle auc (B)')
  approx(gB.tuned[5].merge.old.strict.f1, 1, 'oracle strict f1')
  const m0 = gB.merge.byMargin.find(m => m.margin === 0).decision.pooled; assert.ok(m0.n > 10 && m0.ok === m0.n, '句の判定が全て正しい')
  assert.equal(gB.merge.byMargin.find(m => m.margin === 'inf').decision.pooled.ok, gB.merge.chains.filter(c => c.label === 'both').length, '句を使わないなら、正解が両方の語の列だけ正しい')
  assert.ok(gB.labels.heldout.overCap[3] >= 1, '上限3を超える付箋がある')
  assert.ok(renderB(gB).includes('誕生日の付箋'), 'B のレポートが描画できる')
  console.log('selftest ok')
}

/* ============ main ============ */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  const { values: opt } = parseArgs({
    args: rest,
    options: {
      fixture: { type: 'string', default: join(HERE, 'jev-notes.json') }, out: { type: 'string' }, repeats: { type: 'string', default: '3' },
      phases: { type: 'string', default: 'scaling,main,score,ship,reverse' }, pause: { type: 'string', default: '250' }, resume: { type: 'boolean', default: false },
      central: { type: 'string' }, endpoint: { type: 'string', default: ENDPOINT }, note: { type: 'string', default: 'birthday' }, variant: { type: 'string', default: 'full' }, reverse: { type: 'boolean', default: false },
    },
  })
  if (cmd === 'run') await runCommand(opt)
  else if (cmd === 'analyze') analyzeCommand(opt)
  else if (cmd === 'analyze-b') analyzeBCommand(opt)
  else if (cmd === 'preview') previewCommand(opt)
  else if (cmd === 'selftest') await selftest()
  else { console.error('usage: measure-jev.mjs run|analyze|analyze-b|preview|selftest (ヘッダのコメントを参照)'); process.exitCode = 2 }
}
