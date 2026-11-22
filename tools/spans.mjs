/* 下線の候補を「語」から「語と、の でつないだ句」に広げる規則と、その中から重ならない下線を選ぶ規則。Issue #1。
   純関数だけで、ブラウザも Jev も使わない。tools/extract-jev-candidates.mjs と tools/measure-jev.mjs が読む。
   board.html の extractCandidates は変えない。その出力（語の候補）と Kuromoji のトークンから、ここで句の候補を足す。 */

export const MAX_PARTS = 4
export const MARGINS = [Infinity, 0.3, 0.2, 0.15, 0.1, 0.05, 0, -0.1]

const isNo = t => t.s === 'の' && t.p === '助詞' && t.d1 === '連体化'

/* tokens は { s: surface_form, p: pos, d1: pos_detail_1 } の配列（Kuromoji の出力の写し）。
   candidates は extractCandidates の出力（start 昇順）。隣り合う2語の間が「の（連体化）」1トークンだけなら、つながっているとみなす。
   つながった語の列（A の B の C）から、連続する2語以上（最大 MAX_PARTS 語）の窓を全部、句の候補にする。 */
export function mergeSpans(text, candidates, tokens, { maxParts = MAX_PARTS } = {}) {
  let at = 0
  const toks = tokens.map(t => { const o = { ...t, start: at, end: at + t.s.length }; at = o.end; return o })
  const linked = (a, b) => {
    const gap = toks.filter(t => t.start >= a.end && t.end <= b.start)
    return gap.length === 1 && isNo(gap[0]) && gap[0].start === a.end && gap[0].end === b.start
  }
  const words = candidates.map(c => ({ ...c, merged: false }))
  const chains = []
  let run = []
  for (const c of words) {
    if (run.length && linked(run[run.length - 1], c)) run.push(c)
    else { if (run.length > 1) chains.push(run); run = [c] }
  }
  if (run.length > 1) chains.push(run)
  const merged = []
  for (const chain of chains) {
    for (let len = 2; len <= Math.min(maxParts, chain.length); len++) {
      for (let i = 0; i + len <= chain.length; i++) {
        const win = chain.slice(i, i + len), start = win[0].start, end = win[win.length - 1].end
        merged.push({ surface: text.slice(start, end), start, end, kind: 'phrase', merged: true, parts: win.map(w => w.surface) })
      }
    }
  }
  return [...words, ...merged].sort((a, b) => a.start - b.start || a.end - b.end)
}

export const overlaps = (a, b) => a.start < b.end && b.start < a.end
export const within = (a, b) => b.start <= a.start && a.end <= b.end   // a が b に含まれる

/* 句の候補のうち、他の句に含まれない最長のもの。つながった語の列（chain）ごとに1つ。語2つなら、その句1つが「AのB」 */
export function chainsOf(spans) {
  const merged = spans.filter(s => s.merged)
  return merged.filter(m => !merged.some(o => o !== m && within(m, o)))
    .map(m => ({ span: m, parts: spans.filter(s => !s.merged && within(s, m)), windows: merged.filter(o => within(o, m)) }))
}

/* 値 values（spans と同じ並び）から、重ならない下線を選ぶ。
   句は、有効値 = 値 - margin で語と競う。つまり、句の値が、重なる語のどれよりも margin 以上高いときだけ、先に選ばれる。
   margin = Infinity なら句は使わない（語だけ）。同じ有効値なら語を先にする。
   選ばれるには、実際の値が t 以上であること。数は cap まで。返すのは spans の添字（選んだ順）。 */
export function selectSpans(spans, values, { t, cap, margin = Infinity }) {
  const usable = spans.map((s, i) => i).filter(i => !spans[i].merged || Number.isFinite(margin))
  const eff = i => values[i] - (spans[i].merged ? margin : 0)
  usable.sort((a, b) => eff(b) - eff(a) || Number(spans[a].merged) - Number(spans[b].merged) || spans[a].start - spans[b].start || spans[a].end - spans[b].end)
  const chosen = []
  for (const i of usable) {
    if (chosen.length >= cap) break
    if (values[i] < t - 1e-9) continue
    if (chosen.some(j => overlaps(spans[i], spans[j]))) continue
    chosen.push(i)
  }
  return chosen
}

/* 句の候補1つについて、「句が語に勝つか」だけを見る。値は spans と同じ並び。margin 以上の差で、全ての部分の語より高ければ勝ち */
export function mergeWins(span, spans, values, margin) {
  const i = spans.indexOf(span)
  const parts = spans.map((s, j) => j).filter(j => !spans[j].merged && within(spans[j], span))
  return values[i] - Math.max(...parts.map(j => values[j])) > margin + 1e-9
}
