/* 下線の判定 (Jev = TypeSafe System One) の領域知識。問いの文言、リクエストの形、答えの検証を1か所に持つ。
   server.mjs (POST /judge) と tools/measure-jev.mjs (計測) が共有する。Issue #1。
   問いの文言は計測の前に固めたもので、tools/jev-notes-b.json の protocol.questionSha256 がそのハッシュ。1文字でも変えるときは計測し直す。 */

export const BASE_URL = 'https://api.typesafe.ai'
export const ENDPOINT_PATH = '/v1/systemone'
export const ENDPOINT = BASE_URL + ENDPOINT_PATH
export const MODEL = 'jev-latest'
// 1回の問い合わせで聞く候補の上限と、付箋の長さの上限。ボードはこの範囲に収めて送る
export const LIMITS = { candidates: 30, text: 8000 }

/* ============ 問い ============ */
export const FRAME = '`state.note` は、ユーザーが AI に頼む内容を書いた付箋です。'
export const target = (i, s) => `\`state.candidates[${i}]\`（「${s}」）`
export const only = i => `\`state.candidates[${i}]\` だけを判断し、他の候補のことは考えないでください。`

/* 基準 B: 語にも「の」でつないだ句にも、同じ文言を送る。false の例に地名を挙げない（「日本 → 地域」と合わないため）。
   例の語は ASSUME_EXAMPLES で、計測の付箋のどれにも含めない（tools/measure-jev.mjs の selftest） */
export const ASSUME_EXAMPLES = ['海外', '弁当', '論文', '30分', 'お願いします']
export function assumeQuestion(i, s) {
  return {
    type: 'noul', instructions: `${FRAME}${target(i, s)}は、その付箋にある語、または「の」でつながった語の句です。AI がこの依頼に応えるには、これについて、付箋に書かれていない属性や条件（人数・年齢・地域・日時・予算・対象・調子・長さ・形式・ジャンルなど）を置く必要がありますか。その置き方しだいで、成果物は大きく変わりますか。${only(i)}`,
    criteria: { true: '付箋に書かれていない属性や条件を AI が置かないと進められず、置き方しだいで成果物が大きく変わる。例えば「海外」なら国や地域、「弁当」なら人数や予算、「論文」なら分量や読み手。', false: '必要な属性や条件が付箋の文面にすでに書かれている。または、どう置いても成果物はほとんど変わらない。例えば「30分」のように値が書かれている語、「お願いします」のような依頼の言い回し。' },
  }
}

/* ============ リクエストと答え ============ */
// 付箋1枚の候補全部を、1回の呼び出しで聞く。答えの名前は assume_<候補の添字>
export function judgeRequest(note, candidates) {
  const questions = {}
  candidates.forEach((s, i) => { questions[`assume_${i}`] = assumeQuestion(i, s) })
  return { model: MODEL, state: { note, candidates }, questions }
}

// Jev の応答を、候補ごとの値 (0..1) にする。形が違えば例外を投げる。一部だけ使うことはしない
export function judgeValues(json, candidates) {
  const answers = json?.answers
  if (!answers || typeof answers !== 'object') throw new Error('answers がありません')
  return Object.fromEntries(candidates.map((s, i) => {
    const a = answers[`assume_${i}`]
    if (a?.type !== 'noul' || typeof a.noul !== 'number' || !(a.noul >= 0 && a.noul <= 1)) throw new Error(`assume_${i} が 0 から 1 の noul ではありません`)
    return [s, a.noul]
  }))
}
