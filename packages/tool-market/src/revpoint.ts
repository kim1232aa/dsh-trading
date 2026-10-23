/**
 * 反转点标注 RevPoint v6.5 — port of the user's Pine v6 indicator
 * (/workspace/pine/revpoint.pine). Pure; the browser chart imports this file
 * directly and market_snapshot reads `revPointReport`, so chart and agent agree.
 *
 * Pine `na` is NaN here: every comparison against NaN is false, as in Pine.
 * confirmedOnly (default) = Pine `canRun`: the forming bar never mutates state.
 * HTF values come from candles resampled into UTC-aligned buckets; a bucket is
 * visible to a chart bar only once the bucket has closed by that bar's close
 * (request.security lookahead_off on history). The unclosed HTF bucket is never used.
 * OI comes from our own provider OI history (base-coin units), not TV tickers.
 * @module @dsh-trading/tool-market
 */

export type RpCandle = { t: number; open: number; high: number; low: number; close: number; volume: number }
export type RpOiPoint = { t: number; oi: number }

export const REVPOINT_HTF = [
  { key: '15m', min: 15 }, { key: '30m', min: 30 }, { key: '1H', min: 60 }, { key: '2H', min: 120 }, { key: '4H', min: 240 },
] as const
export type RpTf = typeof REVPOINT_HTF[number]['key']

export type RpOiExch = 'BINANCE' | 'OKX' | 'BYBIT'

export type RevPointOpts = {
  thrPct: number; thrBigPct: number
  showBig: boolean; showSwing: boolean; showC: boolean
  volLen: number; volThr: number; lookbackHours: number
  oiExch: RpOiExch
  minStars: number; needVol: boolean; confirmedOnly: boolean
  showHtf: boolean; htf: Record<RpTf, boolean>; pivotLeg: number
  showHtfSlope: boolean; showHtfPlots: boolean; showHtfHoriz: boolean
  showHtfTable: boolean; showHtfTags: boolean; showHtfDebug: boolean
  chartSec?: number; nowMs?: number
  fmt?: (v: number) => string
}
export const REVPOINT_DEFAULTS: RevPointOpts = {
  thrPct: 0.7, thrBigPct: 2.0, showBig: true, showSwing: true, showC: true,
  volLen: 20, volThr: 2.0, lookbackHours: 24, oiExch: 'BINANCE',
  minStars: 0, needVol: false, confirmedOnly: true,
  showHtf: true, htf: { '15m': false, '30m': false, '1H': true, '2H': false, '4H': true }, pivotLeg: 3,
  showHtfSlope: false, showHtfPlots: false, showHtfHoriz: true,
  showHtfTable: true, showHtfTags: true, showHtfDebug: false,
}

export type RpLine = { x1: number; y1: number; x2: number; y2: number; extend: boolean; style: 'solid' | 'dotted' | 'dashed'; width: number; color: string }
export type RpFineMark = { idx: number; price: number; isTop: boolean; stars: number; tag: '' | 'A' | 'B'; text: string; tip: string; size: number; y: number; bearDiv: boolean }
export type RpBigMark = { idx: number; price: number; isTop: boolean; text: string }
export type RpCBar = { idx: number; up: boolean; volRatio: number; y: number; text: string }
export type RpHtfLevel = { px: number; t: number; active: { t1: number; px1: number; t2: number; px2: number; extend: boolean } | null }
export type RpHtfRow = { tf: RpTf; on: boolean; r: RpHtfLevel; s: RpHtfLevel; color: { r: string; s: string } }
export type RpCandidate = { isTop: boolean; idx: number; price: number; stars: number; need: number; touchTrend: boolean; text: string }

export type RevPointResult = {
  processed: number
  opts: RevPointOpts
  fine: RpFineMark[]; big: RpBigMark[]; cBars: RpCBar[]
  lines: { fineUp: RpLine | null; fineDn: RpLine | null; upLn: RpLine | null; dnLn: RpLine | null }
  htf: RpHtfRow[]
  htfStepPlots: Record<RpTf, { r: number[]; s: number[] }>
  htfDebugText: string
  candidate: RpCandidate | null
  swingTag: { down: boolean; px: number; text: string } | null
  trendUp: boolean; oiChg1h: number; rsi14: number
  fineConfirmed: boolean; bigConfirmed: boolean; cFired: boolean
  barEvents: { fineConfirmed: boolean[]; bigConfirmed: boolean[]; cFired: boolean[] }
}

const N = NaN
const isNa = (v: number) => Number.isNaN(v)
const trim = (v: number, d: number) => String(Number(v.toFixed(d)))
const defFmt = (v: number) => (Math.abs(v) >= 1000 ? trim(v, 1) : Math.abs(v) >= 1 ? trim(v, 4) : String(Number(v.toPrecision(5))))

function smaArr(src: number[], len: number): number[] {
  const out = new Array<number>(src.length).fill(N); let s = 0
  for (let i = 0; i < src.length; i++) { s += src[i]!; if (i >= len) s -= src[i - len]!; if (i >= len - 1) out[i] = s / len }
  return out
}
function stdevArr(src: number[], len: number, mean: number[]): number[] {
  return src.map((_, i) => {
    if (i < len - 1) return N
    let s = 0; for (let k = i - len + 1; k <= i; k++) s += (src[k]! - mean[i]!) ** 2
    return Math.sqrt(s / len)
  })
}
/** Pine ta.rma: seeded with SMA of the first len values. */
function rmaArr(src: number[], len: number): number[] {
  const out = new Array<number>(src.length).fill(N); let acc = 0
  for (let i = 0; i < src.length; i++) {
    if (i < len) { acc += src[i]!; if (i === len - 1) out[i] = acc / len }
    else out[i] = (out[i - 1]! * (len - 1) + src[i]!) / len
  }
  return out
}
/** Pine ta.rsi (Wilder, SMA seed over the first len changes). */
export function pineRsi(c: number[], len: number): number[] {
  const out = new Array<number>(c.length).fill(N); let g = 0, l = 0
  for (let i = 1; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!, up = Math.max(d, 0), dn = Math.max(-d, 0)
    if (i <= len) { g += up / len; l += dn / len; if (i < len) continue }
    else { g = (g * (len - 1) + up) / len; l = (l * (len - 1) + dn) / len }
    out[i] = l === 0 ? 100 : g === 0 ? 0 : 100 - 100 / (1 + g / l)
  }
  return out
}
function highestArr(src: number[], len: number, mx: boolean): number[] {
  return src.map((_, i) => {
    if (i < len - 1) return N
    let v = src[i]!; for (let k = i - len + 1; k <= i; k++) v = mx ? Math.max(v, src[k]!) : Math.min(v, src[k]!)
    return v
  })
}
const at = (a: number[], i: number) => (i >= 0 && i < a.length ? a[i]! : N)

/** Bar period in seconds = smallest positive gap between consecutive bars. */
export function inferChartSec(c: readonly { t: number }[]): number {
  let m = Infinity
  for (let i = 1; i < c.length; i++) { const d = c[i]!.t - c[i - 1]!.t; if (d > 0 && d < m) m = d }
  return Number.isFinite(m) ? m / 1000 : 60
}

type HtfBar = { t: number; close: number; high: number; low: number; closeT: number }
/** Resample to UTC-aligned buckets, keeping only buckets closed by `closedBy` (ms). */
export function resampleClosed(c: readonly RpCandle[], tfSec: number, closedBy: number): HtfBar[] {
  const ms = tfSec * 1000, out: HtfBar[] = []
  for (const b of c) {
    const t = Math.floor(b.t / ms) * ms
    const last = out.at(-1)
    if (last && last.t === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close }
    else out.push({ t, close: b.close, high: b.high, low: b.low, closeT: t + ms })
  }
  return out.filter(h => h.closeT <= closedBy)
}

/** Pine ta.pivothigh/low(leg, leg): left strictly beyond, right not beyond (TV tie rule approximation). */
function pivotAt(h: HtfBar[], j: number, leg: number, hi: boolean): number {
  const p = j - leg; if (p - leg < 0 || j >= h.length) return N
  const v = hi ? h[p]!.high : h[p]!.low
  for (let k = p - leg; k <= p + leg; k++) {
    if (k === p) continue
    const w = hi ? h[k]!.high : h[k]!.low
    if (k < p ? (hi ? w >= v : w <= v) : (hi ? w > v : w < v)) return N
  }
  return v
}

type Pack = { h1: number; ht1: number; h2: number; ht2: number; l1: number; lt1: number; l2: number; lt2: number }
const emptyPack = (): Pack => ({ h1: N, ht1: N, h2: N, ht2: N, l1: N, lt1: N, l2: N, lt2: N })

/** htfPack() series projected onto chart bars without lookahead. */
export function htfPackSeries(c: readonly RpCandle[], chartSec: number, tfSec: number, leg: number): Pack[] {
  const closedBy = c.length ? c.at(-1)!.t + chartSec * 1000 : 0
  const h = resampleClosed(c, tfSec, closedBy)
  const packs: Pack[] = []; let p = emptyPack()
  for (let j = 0; j < h.length; j++) {
    const ph = pivotAt(h, j, leg, true), pl = pivotAt(h, j, leg, false)
    p = { ...p }
    if (!isNa(ph)) { p.h2 = p.h1; p.ht2 = p.ht1; p.h1 = ph; p.ht1 = h[j - leg]!.t }
    if (!isNa(pl)) { p.l2 = p.l1; p.lt2 = p.lt1; p.l1 = pl; p.lt1 = h[j - leg]!.t }
    packs.push(p)
  }
  const out: Pack[] = []; let k = -1
  for (const b of c) {
    const close = b.t + chartSec * 1000
    while (k + 1 < h.length && h[k + 1]!.closeT <= close) k++
    out.push(k >= 0 ? packs[k]! : emptyPack())
  }
  return out
}

/** request.security("60", ta.ema(close,21)) without lookahead, per chart bar. */
export function ema1hSeries(c: readonly RpCandle[], chartSec: number): number[] {
  const closedBy = c.length ? c.at(-1)!.t + chartSec * 1000 : 0
  const h = resampleClosed(c, 3600, closedBy)
  const a = 2 / 22; const e: number[] = []
  h.forEach((b, j) => e.push(j === 0 ? b.close : a * b.close + (1 - a) * e[j - 1]!))
  const out: number[] = []; let k = -1
  for (const b of c) {
    const close = b.t + chartSec * 1000
    while (k + 1 < h.length && h[k + 1]!.closeT <= close) k++
    out.push(k >= 0 ? e[k]! : N)
  }
  return out
}

/** OI at each chart bar's close from provider history (latest point at or before close, ≤ 1 bar + 10 min stale). */
export function oiOnBars(c: readonly RpCandle[], chartSec: number, oi: readonly RpOiPoint[]): number[] {
  const pts = [...oi].filter(p => Number.isFinite(p.oi) && p.oi > 0).sort((a, b) => a.t - b.t)
  let k = -1
  return c.map(b => {
    const close = b.t + chartSec * 1000
    while (k + 1 < pts.length && pts[k + 1]!.t <= close) k++
    return k >= 0 && close - pts[k]!.t <= chartSec * 1000 + 600_000 ? pts[k]!.oi : N
  })
}

type PState = { price: number; barIdx: number; volRatio: number; oiChg: number; rsi: number; pctB: number; touchLevel: boolean; extreme12h: boolean; stall: boolean }
type LP = { barIdx: number; price: number }

/** line.get_price: linear in bar index along the line's two points. */
export function linePriceAt(l: RpLine, x: number): number {
  if (l.x2 === l.x1) return l.y1
  return l.y1 + (l.y2 - l.y1) * (x - l.x1) / (l.x2 - l.x1)
}
/** freezeLine(): stop extending, dashed, width 1, end at the current bar. */
export function freezeLine(l: RpLine | null, barIndex: number): RpLine | null {
  if (l === null) return null
  const y = linePriceAt(l, barIndex)
  return { ...l, extend: false, style: 'dashed', width: 1, ...(isNa(y) ? {} : { x2: barIndex, y2: y }) }
}
/** swingConnect(): two points → solid ray; one point → dotted horizontal water level. */
export function swingConnect(a: LP, b: LP, barIndex: number, color: string, w: number): RpLine | null {
  const two = !isNa(a.price) && !isNa(a.barIdx) && !isNa(b.price) && !isNa(b.barIdx) && a.barIdx !== b.barIdx
  if (two) return { x1: a.barIdx, y1: a.price, x2: b.barIdx, y2: b.price, extend: true, style: 'solid', width: w, color }
  if (!isNa(b.price) && !isNa(b.barIdx)) return { x1: b.barIdx, y1: b.price, x2: barIndex, y2: b.price, extend: true, style: 'dotted', width: Math.max(1, w - 1), color }
  return null
}

const HTF_COL: Record<RpTf, { r: string; s: string; w: number }> = {
  '15m': { r: '#ef9a9a', s: '#80cbc4', w: 1 }, '30m': { r: '#ff8a65', s: '#4dd0e1', w: 2 }, '1H': { r: '#e24b4a', s: '#1aa38a', w: 2 },
  '2H': { r: '#ec407a', s: '#26a69a', w: 2 }, '4H': { r: '#ff5252', s: '#00bfa5', w: 3 },
}
export const starGlyphs = (n: number) => '★'.repeat(Math.max(0, n))

export function revPoint(all: readonly RpCandle[], oi: readonly RpOiPoint[] = [], o: Partial<RevPointOpts> = {}): RevPointResult {
  const op: RevPointOpts = { ...REVPOINT_DEFAULTS, ...o, htf: { ...REVPOINT_DEFAULTS.htf, ...(o.htf ?? {}) } }
  const fmt = op.fmt ?? defFmt
  const chartSec = op.chartSec ?? inferChartSec(all)
  const now = op.nowMs ?? Date.now()
  const formingLast = op.confirmedOnly && all.length > 0 && all.at(-1)!.t + chartSec * 1000 > now
  const c = formingLast ? all.slice(0, -1) : all
  const thr = op.thrPct / 100, thrBig = op.thrBigPct / 100
  const H = c.map(b => b.high), L = c.map(b => b.low), C = c.map(b => b.close), O = c.map(b => b.open), V = c.map(b => b.volume)

  const volSma = smaArr(V, op.volLen)
  const volRatio = V.map((v, i) => v / volSma[i]!)
  const tr = c.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - C[i - 1]!), Math.abs(b.low - C[i - 1]!))))
  const atr14 = rmaArr(tr, 14)
  const rsi14 = pineRsi(C, 14)
  const bbBasis = smaArr(C, 20), bbDevRaw = stdevArr(C, 20, bbBasis)
  const pctB = C.map((x, i) => { const d = 2 * bbDevRaw[i]!; return d === 0 ? 0.5 : (x - (bbBasis[i]! - d)) / (2 * d) })
  const lookbk = Math.max(20, Math.round(op.lookbackHours * 3600 / chartSec))
  const hiLb = highestArr(H, lookbk, true), loLb = highestArr(L, lookbk, false)
  const bars1h = Math.max(1, Math.round(3600 / chartSec))
  const bars12h = Math.max(2, Math.round(43200 / chartSec))
  const low12 = highestArr(L, bars12h, false), high12 = highestArr(H, bars12h, true)
  const ema1h = ema1hSeries(c, chartSec)
  const trendUpAt = (i: number) => at(ema1h, i) > at(ema1h, i - bars1h)
  const oiC = oiOnBars(c, chartSec, oi)
  const oiChgAt = (i: number) => { const a = at(oiC, i), b = at(oiC, i - bars1h); return isNa(a) || isNa(b) || b === 0 ? N : 100 * (a - b) / b }
  const tag = (i: number, isTop: boolean) => ((isTop ? trendUpAt(i) : !trendUpAt(i)) ? ' 逆1H' : ' 顺1H')

  const starCount = (p: PState, isTop: boolean) =>
    (p.volRatio >= op.volThr ? 1 : 0) + (isTop && p.touchLevel ? 1 : 0) +
    (!isNa(p.oiChg) && (isTop ? p.oiChg >= 0.3 : p.oiChg <= -0.25) ? 1 : 0) + (p.extreme12h ? 1 : 0)
  const snap = (p: PState, i: number, px: number, touch: boolean, ext: boolean, stall: boolean) => {
    p.price = px; p.barIdx = i; p.volRatio = at(volRatio, i); p.oiChg = oiChgAt(i); p.rsi = at(rsi14, i); p.pctB = at(pctB, i)
    p.touchLevel = touch; p.extreme12h = ext; p.stall = stall
  }
  const fine: RpFineMark[] = [], big: RpBigMark[] = [], cBars: RpCBar[] = []
  const drawLabel = (p: PState, i: number, isTop: boolean, bearDiv: boolean, tlTch: boolean) => {
    const st = starCount(p, isTop)
    if (!(st >= op.minStars && (!op.needVol || p.volRatio >= op.volThr))) return
    const sp = isTop ? (p.volRatio < 1.5 && p.stall ? 'B·缩量衰竭 ' : '') : (p.volRatio >= op.volThr ? 'A·放量V底 ' : '')
    const oiHit = !isNa(p.oiChg) && (isTop ? p.oiChg >= 0.3 : p.oiChg <= -0.25)
    const tip = sp + starGlyphs(st) + ' ' + fmt(p.price) +
      (p.volRatio >= op.volThr ? ' ' + trim(p.volRatio, 1) + 'x' : '') +
      (oiHit ? ' OI' + (p.oiChg > 0 ? '+' : '') + trim(p.oiChg, 2) + '%' : '') +
      (p.extreme12h ? ' 12h极值' : '') + (p.stall ? (isTop ? ' (滞涨)' : ' (滞跌)') : '') +
      (bearDiv ? ' (背离)' : '') + (!isTop && tlTch ? ' (触趋线)' : '') +
      (!isTop && (p.rsi <= 35 || p.pctB <= 0.1) ? ' 超卖' : '') + tag(i, isTop)
    const a = at(atr14, i)
    fine.push({ idx: p.barIdx, price: p.price, isTop, stars: st, tag: sp.startsWith('A') ? 'A' : sp.startsWith('B') ? 'B' : '',
      text: isTop ? '▼' : '▲', tip, size: 9 + st * 5, y: isTop ? p.price + 0.3 * a : p.price - 0.3 * a, bearDiv })
  }

  let dir: 'up' | 'down' = 'up'
  const curExt: PState = { price: c[0]?.high ?? N, barIdx: 0, volRatio: N, oiChg: N, rsi: N, pctB: N, touchLevel: false, extreme12h: false, stall: false }
  let lastTop: PState = { ...curExt, price: N, barIdx: N }
  let upLn: RpLine | null = null, dnLn: RpLine | null = null, fineUp: RpLine | null = null, fineDn: RpLine | null = null
  let fTopA: LP = { barIdx: N, price: N }, fTopB: LP = { ...fTopA }, fBotA: LP = { ...fTopA }, fBotB: LP = { ...fTopA }
  let dirB: 'up' | 'down' = 'up', extBg = c[0]?.high ?? N, extBB = 0
  let topA: LP = { barIdx: N, price: N }, topB: LP = { ...topA }, botA: LP = { ...topA }, botB: LP = { ...topA }
  let lastC = -99
  let fineConfirmed = false, bigConfirmed = false, cFired = false
  const barFine = new Array<boolean>(all.length).fill(false)
  const barBig = new Array<boolean>(all.length).fill(false)
  const barC = new Array<boolean>(all.length).fill(false)
  type Tl = { lastSeenPx: number; lastSeenT: number; aPx: number; aTime: number; bPx: number; bTime: number; active: RpHtfLevel['active'] }
  const newTl = (): Tl => ({ lastSeenPx: N, lastSeenT: N, aPx: N, aTime: N, bPx: N, bTime: N, active: null })
  const tfs = REVPOINT_HTF.map(d => ({ ...d, sec: d.min * 60, packs: [] as Pack[], r: newTl(), s: newTl(), on: false }))
  for (const tf of tfs) {
    tf.on = op.showHtf && tf.sec >= chartSec && op.htf[tf.key]
    if (tf.on) tf.packs = htfPackSeries(c, chartSec, tf.sec, op.pivotLeg)
  }
  const levelAt = (s: Tl, t: number) => {
    if (!isNa(s.bPx) && (isNa(s.aPx) || isNa(s.aTime) || isNa(s.bTime) || s.aTime === s.bTime)) return s.bPx
    if (!isNa(s.aPx) && !isNa(s.bPx) && !isNa(s.aTime) && !isNa(s.bTime)) return s.aPx + (s.bPx - s.aPx) * (t - s.aTime) / (s.bTime - s.aTime)
    return N
  }
  const applyPack = (s: Tl, lp: number, lt: number, pp: number, pt: number, time: number) => {
    const has = !isNa(lp) && !isNa(lt)
    if (!(has && (isNa(s.lastSeenT) || lt !== s.lastSeenT || lp !== s.lastSeenPx))) return
    s.active = null
    s.aPx = op.showHtfSlope ? pp : lp; s.aTime = op.showHtfSlope ? pt : lt; s.bPx = lp; s.bTime = lt; s.lastSeenPx = lp; s.lastSeenT = lt
    const two = op.showHtfSlope && !isNa(pp) && !isNa(pt) && pt !== lt
    if (two) s.active = { t1: pt, px1: pp, t2: lt, px2: lp, extend: true }
    else if (op.showHtfHoriz || !op.showHtfSlope) s.active = { t1: lt, px1: lp, t2: time, px2: lp, extend: true }
  }

  for (let i = 0; i < c.length; i++) {
    const b = c[i]!
    fineConfirmed = false; bigConfirmed = false; cFired = false
    const a = at(atr14, i), pH = at(hiLb, i - 7), pL = at(loLb, i - 7)
    const stallUp = C[i]! - at(C, i - 6) < 0.3 * a, stallDn = at(C, i - 6) - C[i]! < 0.3 * a
    if (dir === 'up') {
      if (b.high >= curExt.price) snap(curExt, i, b.high, b.high >= pH - 0.7 * a, b.high >= at(high12, i), stallUp)
      if ((curExt.price - b.low) / curExt.price >= thr) {
        const bearDiv = !isNa(lastTop.price) && curExt.price > lastTop.price && !isNa(lastTop.rsi) && curExt.rsi < lastTop.rsi - 2
        drawLabel(curExt, i, true, bearDiv, false)
        lastTop = { ...curExt }
        dir = 'down'
        if (op.showSwing) {
          fTopA = { ...fTopB }; fTopB = { barIdx: curExt.barIdx, price: curExt.price }
          fineUp = freezeLine(fineUp, i)
          fineDn = swingConnect(fTopA, fTopB, i, '#e24b4a', 2)
        }
        snap(curExt, i, b.low, b.low <= pL + 0.7 * a, b.low <= at(low12, i), stallDn)
        fineConfirmed = true
      }
    } else {
      if (b.low <= curExt.price) snap(curExt, i, b.low, b.low <= pL + 0.7 * a, b.low <= at(low12, i), stallDn)
      if ((b.high - curExt.price) / curExt.price >= thr) {
        const tlTouch = upLn !== null && Math.abs(curExt.price - linePriceAt(upLn, curExt.barIdx)) <= 0.5 * a
        drawLabel(curExt, i, false, false, tlTouch)
        dir = 'up'
        if (op.showSwing) {
          fBotA = { ...fBotB }; fBotB = { barIdx: curExt.barIdx, price: curExt.price }
          fineDn = freezeLine(fineDn, i)
          fineUp = swingConnect(fBotA, fBotB, i, '#1aa38a', 2)
        }
        snap(curExt, i, b.high, b.high >= pH - 0.7 * a, b.high >= at(high12, i), stallUp)
        fineConfirmed = true
      }
    }

    const cDry = (at(volRatio, i - 1) + at(volRatio, i - 2) + at(volRatio, i - 3) + at(volRatio, i - 4)) / 4 <= 0.7
    const cGiant = at(volRatio, i) >= 4 && Math.abs(b.close - b.open) >= 1.2 * a
    if (cDry && cGiant) cFired = true
    if (op.showC && cDry && cGiant && i - lastC >= 6) {
      lastC = i
      const up = b.close >= b.open
      cBars.push({ idx: i, up, volRatio: volRatio[i]!, y: up ? b.low : b.high, text: 'C·枯竭爆量' + (up ? '↑' : '↓') + trim(volRatio[i]!, 1) + 'x' })
    }

    if (op.showBig) {
      if (dirB === 'up') {
        if (b.high >= extBg) { extBg = b.high; extBB = i }
        if ((extBg - b.low) / extBg >= thrBig) {
          big.push({ idx: extBB, price: extBg, isTop: true, text: '◆大顶\n' + fmt(extBg) + tag(i, true) })
          topA = { ...topB }; topB = { barIdx: extBB, price: extBg }
          if (op.showSwing) { upLn = freezeLine(upLn, i); dnLn = swingConnect(topA, topB, i, '#c62828', 2) }
          dirB = 'down'; extBg = b.low; extBB = i; bigConfirmed = true
        }
      } else {
        if (b.low <= extBg) { extBg = b.low; extBB = i }
        if ((b.high - extBg) / extBg >= thrBig) {
          big.push({ idx: extBB, price: extBg, isTop: false, text: '◆大底\n' + fmt(extBg) + tag(i, false) })
          botA = { ...botB }; botB = { barIdx: extBB, price: extBg }
          if (op.showSwing) { dnLn = freezeLine(dnLn, i); upLn = swingConnect(botA, botB, i, '#0b6e4f', 2) }
          dirB = 'up'; extBg = b.high; extBB = i; bigConfirmed = true
        }
      }
    }

    for (const tf of tfs) {
      if (!tf.on) continue
      const p = tf.packs[i]!
      for (const [s, isRes] of [[tf.r, true], [tf.s, false]] as [Tl, boolean][]) {
        if (s.active !== null) { const lvl = levelAt(s, b.t); if (!isNa(lvl) && (isRes ? b.close > lvl : b.close < lvl)) s.active = null }
      }
      applyPack(tf.r, p.h1, p.ht1, p.h2, p.ht2, b.t)
      applyPack(tf.s, p.l1, p.lt1, p.l2, p.lt2, b.t)
    }
    barFine[i] = fineConfirmed; barBig[i] = bigConfirmed; barC[i] = cFired
  }

  const n = c.length, li = n - 1
  const lastPack = (tf: typeof tfs[number]) => (tf.on && n > 0 ? tf.packs[li]! : emptyPack())
  const htf: RpHtfRow[] = tfs.map(tf => {
    const p = lastPack(tf)
    return { tf: tf.key, on: tf.on, color: { r: HTF_COL[tf.key].r, s: HTF_COL[tf.key].s },
      r: { px: p.h1, t: p.ht1, active: tf.on ? tf.r.active : null }, s: { px: p.l1, t: p.lt1, active: tf.on ? tf.s.active : null } }
  })
  let candidate: RpCandidate | null = null
  if (n > 0) {
    const closeNow = all.at(-1)!.close
    const isTop = dir === 'up'
    const back = isTop ? (curExt.price - closeNow) / curExt.price : (closeNow - curExt.price) / curExt.price
    const need = (thr - back) * 100
    const tlC = !isTop && upLn !== null && Math.abs(curExt.price - linePriceAt(upLn, curExt.barIdx)) <= 0.5 * at(atr14, li)
    const st = starCount(curExt, isTop)
    const oc = oiChgAt(li)
    const text = (isTop ? '候选顶 ' : '候选底 ') + fmt(curExt.price) + starGlyphs(st) + (tlC ? ' 触趋线' : '') + tag(li, isTop) +
      (isNa(oc) ? '' : '  OI1h ' + (oc > 0 ? '+' : '') + trim(oc, 2) + '%') +
      (isNa(curExt.rsi) ? '' : '  RSI' + Math.round(curExt.rsi)) +
      (need > 0 ? '\n还差 ' + trim(need, 2) + '% 确认' : '\n确认边缘')
    candidate = { isTop, idx: curExt.barIdx, price: curExt.price, stars: st, need, touchTrend: tlC, text }
  }
  let swingTag: RevPointResult['swingTag'] = null
  if (op.showSwing) {
    const down = dir === 'down', px = down ? fTopB.price : fBotB.price
    if (!isNa(px)) swingTag = { down, px, text: (down ? '↓趋 ' : '↑趋 ') + fmt(px) }
  }
  const htfStepPlots = {} as Record<RpTf, { r: number[]; s: number[] }>
  for (const tf of tfs) {
    const on = tf.on && op.showHtfPlots
    const rArr = new Array<number>(all.length).fill(N)
    const sArr = new Array<number>(all.length).fill(N)
    if (on) {
      for (let i = 0; i < tf.packs.length; i++) {
        rArr[i] = tf.packs[i]!.h1
        sArr[i] = tf.packs[i]!.l1
      }
    }
    htfStepPlots[tf.key] = { r: rArr, s: sArr }
  }
  const dbgRow = (tf: typeof tfs[number], p: Pack) =>
    `${tf.key}(${tf.on ? '开' : '关'}): R1=${isNa(p.h1) ? 'na' : fmt(p.h1)} R2=${isNa(p.h2) ? 'na' : fmt(p.h2)} | S1=${isNa(p.l1) ? 'na' : fmt(p.l1)} S2=${isNa(p.l2) ? 'na' : fmt(p.l2)}`
  const htfDebugText = op.showHtf && op.showHtfDebug && n > 0
    ? [
        `HTF诊断 pivLen=${op.pivotLeg} 斜线=${op.showHtfSlope ? '开' : '关'} 水平=${op.showHtfHoriz ? '开' : '关'}`,
        ...tfs.map(tf => dbgRow(tf, lastPack(tf))),
      ].join('\n')
    : ''

  return {
    processed: n, opts: op, fine, big, cBars, lines: { fineUp, fineDn, upLn, dnLn }, htf,
    htfStepPlots, htfDebugText, candidate, swingTag,
    trendUp: n > 0 && trendUpAt(li), oiChg1h: n > 0 ? oiChgAt(li) : N, rsi14: at(rsi14, li),
    fineConfirmed, bigConfirmed, cFired,
    barEvents: { fineConfirmed: barFine, bigConfirmed: barBig, cFired: barC },
  }
}

export type RevPointReport = {
  candidate: { side: 'top' | 'bottom'; price: number; stars: number; needPct: number | null; text: string } | null
  lastFine: { side: 'top' | 'bottom'; price: number; stars: number; tip: string } | null
  lastBig: { side: 'top' | 'bottom'; price: number } | null
  trend1h: 'up' | 'down'
  oiChg1hPct: number | null
  htf: { tf: RpTf; R: number | null; S: number | null; rActive: boolean; sActive: boolean }[]
}
const nn = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(8)) : null)

export function revPointReport(candles: readonly { time: string; open: number; high: number; low: number; close: number; volume: number }[],
  oi: readonly RpOiPoint[] = [], o: Partial<RevPointOpts> = {}): RevPointReport {
  const r = revPoint(candles.map(c => ({ t: Date.parse(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })), oi, o)
  const lf = r.fine.at(-1), lb = r.big.at(-1)
  return {
    candidate: r.candidate === null ? null : { side: r.candidate.isTop ? 'top' : 'bottom', price: nn(r.candidate.price)!, stars: r.candidate.stars,
      needPct: r.candidate.need > 0 ? Number(r.candidate.need.toFixed(2)) : null, text: r.candidate.text.replace('\n', ' ') },
    lastFine: lf ? { side: lf.isTop ? 'top' : 'bottom', price: nn(lf.price)!, stars: lf.stars, tip: lf.tip } : null,
    lastBig: lb ? { side: lb.isTop ? 'top' : 'bottom', price: nn(lb.price)! } : null,
    trend1h: r.trendUp ? 'up' : 'down',
    oiChg1hPct: Number.isFinite(r.oiChg1h) ? Number(r.oiChg1h.toFixed(2)) : null,
    htf: r.htf.filter(h => h.on).map(h => ({ tf: h.tf, R: nn(h.r.px), S: nn(h.s.px), rActive: h.r.active !== null, sActive: h.s.active !== null })),
  }
}

export function renderRevPoint(r: RevPointReport): string {
  const c = r.candidate
  const cand = c === null ? '无候选' : `${c.side === 'top' ? '候选顶' : '候选底'} ${c.price} ${'★'.repeat(c.stars) || '0★'} ${c.needPct === null ? '确认边缘' : `还差 ${c.needPct}% 确认`}`
  const lf = r.lastFine ? `上个细档${r.lastFine.side === 'top' ? '顶' : '底'} ${r.lastFine.tip}` : '无细档确认'
  const lb = r.lastBig ? `大周期${r.lastBig.side === 'top' ? '顶' : '底'} ${r.lastBig.price}` : '无大周期点'
  const h = r.htf.map(x => `${x.tf} R ${x.R ?? '—'}${x.R !== null && !x.rActive ? '(已破)' : ''} S ${x.S ?? '—'}${x.S !== null && !x.sActive ? '(已破)' : ''}`).join(' ')
  return `  RevPoint反转点 [0.7%细档/2%粗档, 收盘确认]: ${cand} | ${lf} | ${lb} | 1H EMA21 ${r.trend1h === 'up' ? '上行' : '下行'}${r.oiChg1hPct === null ? '' : ` | OI1h ${r.oiChg1hPct > 0 ? '+' : ''}${r.oiChg1hPct}%`}${h ? ` | ${h}` : ''}`
}
