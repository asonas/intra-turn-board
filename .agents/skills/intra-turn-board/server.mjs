import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const parent = process.env.CODEX_THREAD_ID
if (!parent) throw new Error('現在の Codex セッションで起動してください (CODEX_THREAD_ID が必要です)')
const token = randomBytes(24).toString('hex')
const page = await readFile(new URL('board.html', import.meta.url))
const schema = fileURLToPath(new URL('draft.json', import.meta.url))

async function generate(data, signal) {
  const starting = data.stage === 'start'
  const fields = starting ? ['topic'] : ['topic','draft']
  if (data.intent) fields.push('intent')
  if ((!starting && data.stage !== 'finish') || fields.some(k => typeof data[k] !== 'string' || !data[k].trim() || data[k].length > 8000)) {
    throw new Error('入力は各欄1〜8000文字です')
  }
  const task = starting
    ? '依頼にすぐ取りかかり、判断をユーザーに委ねたい一点を文中に残してください。before と after は空欄の前後の文章、label は未決事項の短い名前、choices はそこに代入すると文が成立する短い候補を2〜4個。intent はユーザーが選んだ方向です。'
    : 'draft はユーザーが空欄を埋めた文章です。その決定を具体化して、元の依頼への成果物を続けて短く書いてください。'
  const prompt = task + ' 日本語で返答し、ツールは使用しないでください。付箋のデータ：' + JSON.stringify(Object.fromEntries(fields.map(k => [k,data[k]])))
  const args = ['-a','never','exec','-s','read-only','fork', '--ephemeral','--json']
  if (starting) args.push('--output-schema', schema)
  args.push(parent, '-')
  const child = spawn('codex', args, {signal, stdio:['pipe','pipe','inherit']})
  const result = new Promise((resolve,reject) => {
    let output = ''
    child.stdout.setEncoding('utf8').on('data', part => { output += part })
    child.on('error', reject)
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error('Codex の実行に失敗しました')
        const events = output.trim().split('\n').map(line => JSON.parse(line))
        const message = events.findLast(e => e.type === 'item.completed' && e.item.type === 'agent_message')?.item.text
        if (!message?.trim()) throw new Error('Codex の応答が空です')
        const value = starting ? JSON.parse(message) : { continuation:message }
        if (starting && (!value.label?.trim() || !Array.isArray(value.choices) || value.choices.length < 2)) throw new Error('空欄の候補を取得できませんでした')
        resolve({...value, usage:events.findLast(e => e.type === 'turn.completed')?.usage})
      } catch (error) {reject(error)}
    })
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
  return result
}

const server = http.createServer(async (req,res) => {
  const origin = 'http://127.0.0.1:' + server.address().port
  const url = new URL(req.url, origin)
  res.setHeader('Cache-Control','no-store')
  res.setHeader('Referrer-Policy','no-referrer')
  res.setHeader('X-Frame-Options','DENY')
  if (req.headers.host !== new URL(origin).host || url.searchParams.get('t') !== token) {
    res.writeHead(403).end(); return
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(page); return
  }
  if (req.method !== 'POST' || url.pathname !== '/generate' || req.headers.origin !== origin) {
    res.writeHead(403).end(); return
  }
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  try {
    const chunks = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 150000) {res.writeHead(413).end(); return}
      chunks.push(chunk)
    }
    const start = Date.now()
    const result = await generate(JSON.parse(Buffer.concat(chunks)), AbortSignal.any([controller.signal,AbortSignal.timeout(180000)]))
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({...result, ms:Date.now()-start}))
  } catch (error) {
    res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message}))
  }
})
server.listen(0,'127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port + '/?t=' + token))
