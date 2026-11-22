#!/usr/bin/env node
/* tools/jev-notes.json の各付箋に、ボード自身のコードで取り出した候補（candidates）と、現行ルールの上位3語（baselineTop3）を書き込む。Issue #1 のステップ1。

   PLAYWRIGHT_DIR=/path/to/dir-with-node_modules node tools/extract-jev-candidates.mjs [--fixture PATH] [--board PATH] [--chromium PATH]

   board.html を file:// で headless Chromium に読み込み、Kuromoji の辞書を読み終えたあと、ページ内の
   extractCandidates / rank をそのまま呼ぶ（再実装しない）。playwright-core はこのリポジトリの依存ではないので、
   PLAYWRIGHT_DIR に node_modules/playwright-core を含むディレクトリを指定する。
   underline と unsure の語が候補に無ければ失敗する（ラベルの書き間違いを防ぐ）。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const { values: opt } = parseArgs({
  options: {
    fixture: { type: 'string', default: join(HERE, 'jev-notes.json') },
    board: { type: 'string', default: join(REPO, '.agents/skills/intra-turn-board/board.html') },
    chromium: { type: 'string' },
  },
})

function findChromium() {
  if (opt.chromium) return opt.chromium
  const root = join(homedir(), 'Library/Caches/ms-playwright')
  const dir = readdirSync(root).filter(d => d.startsWith('chromium_headless_shell-')).sort().at(-1)
  if (!dir) throw new Error('chromium_headless_shell が見つからない。--chromium で指定する')
  return join(root, dir, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')
}

const pwDir = process.env.PLAYWRIGHT_DIR
if (!pwDir) throw new Error('PLAYWRIGHT_DIR に node_modules/playwright-core を含むディレクトリを指定する')
const { chromium } = createRequire(join(resolve(pwDir), 'package.json'))('playwright-core')

/* 付箋1件ぶんの JSON。candidates は1候補1行にして、差分と目視を読みやすくする */
export function formatFixture(fx) {
  const { notes, ...head } = fx
  const lines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')}`)
  const noteBlocks = notes.map(n => {
    const { candidates, ...rest } = n
    const fields = Object.entries(rest).map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    if (candidates) fields.push(`      "candidates": [\n${candidates.map(c => `        ${JSON.stringify(c)}`).join(',\n')}\n      ]`)
    return `    {\n${fields.join(',\n')}\n    }`
  })
  lines.push(`  "notes": [\n${noteBlocks.join(',\n')}\n  ]`)
  return `{\n${lines.join(',\n')}\n}\n`
}

const fixture = JSON.parse(readFileSync(opt.fixture, 'utf8'))
const browser = await chromium.launch({ executablePath: findChromium() })
try {
  const page = await browser.newPage()
  const ready = new Promise((ok, ng) => {
    page.on('console', m => { if (m.text().includes('[kuromoji] dictionary ready')) ok() })
    setTimeout(() => ng(new Error('Kuromoji の辞書が 60 秒以内に読み込めなかった')), 60_000)
  })
  await page.goto('file://' + resolve(opt.board))
  await ready
  const { examples, kuromoji } = await page.evaluate(() => ({ examples: Object.values(EXAMPLES), kuromoji: KUROMOJI.script }))
  const rows = await page.evaluate(texts => texts.map(text => {
    const candidates = extractCandidates(tokenizer.tokenize(text))
    return { candidates, baselineTop3: rank(candidates, text).slice(0, 3).map(c => c.surface) }
  }), fixture.notes.map(n => n.text))

  const problems = []
  fixture.notes.forEach((n, i) => {
    if (n.tag.startsWith('example/') && !examples.includes(n.text)) problems.push(`${n.id}: board.html の EXAMPLES と文が違う`)
    n.candidates = rows[i].candidates
    n.baselineTop3 = rows[i].baselineTop3
    const surfaces = new Set(n.candidates.map(c => c.surface))
    for (const s of [...n.underline, ...n.unsure]) if (!surfaces.has(s)) problems.push(`${n.id}: 「${s}」は候補にない（候補: ${[...surfaces].join(' / ')}）`)
    for (const s of n.unsure) if (n.underline.includes(s)) problems.push(`${n.id}: 「${s}」が underline と unsure の両方にある`)
  })
  const git = args => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim()
  const source = {
    board: resolve(opt.board).replace(REPO + '/', ''),
    gitHead: git(['rev-parse', 'HEAD']),
    boardBlob: git(['hash-object', resolve(opt.board)]),
    kuromoji: kuromoji.match(/kuromoji@[\d.]+/)?.[0],
    extractedAt: new Date().toISOString(),
  }
  // board.html と Kuromoji が同じなら source を書き換えない。fixture の sha256 を、再抽出で変えないため
  const same = fixture.source?.boardBlob === source.boardBlob && fixture.source?.kuromoji === source.kuromoji
  if (!same) fixture.source = source
  writeFileSync(opt.fixture, formatFixture(fixture))
  for (const n of fixture.notes) console.log(`${n.id} (${[...n.text].length}字): ${n.candidates.map(c => `${c.surface}[${c.kind[0]}]`).join(' ')}  | baseline: ${n.baselineTop3.join(' ')}`)
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1 }
} finally {
  await browser.close()
}
