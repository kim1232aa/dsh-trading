/**
 * The persistent chart column: the occupant of the trading frame's
 * `trading.chart` seat.
 *
 * It is driven from BOTH ends, which is the whole point:
 *
 *  - **The user** types a symbol and picks a timeframe. That goes straight to
 *    `ctx.marketData` over the host channel — no tool call, no model in the
 *    loop. A workbench whose only input is "hope the agent calls the right
 *    tool" is not a workbench.
 *  - **The model** produces `market_snapshot` / `annotate_chart` results, whose
 *    payloads the cards publish; the panel adopts the newest one so the chart
 *    the agent reasoned about stops scrolling away with the conversation.
 *
 * The user's own lookup wins while it is on screen — an agent answer must not
 * yank the chart out from under someone mid-read. "Follow the agent" is a
 * toggle, not a surprise.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import type { ChartOwnerProps } from '@dsh-trading/client-frame/client'
import { ChartBody, ChartErrorBoundary } from './ChartCard.js'
import { getLatestChart, subscribeLatestChart } from './latest.js'
import { decideFollow } from './follow.js'
import { mergeMarks, mergeTail, postureColor, readMarks, recallMarks, rememberMarks, withCandles } from './market-client.js'
import type { ChartMarks, MarketClient, PanelDerivatives, PanelMoneyFlow } from './market-client.js'
import type { ChartPayload } from './payload.js'
import type { FundamentalsPackage, Orderbook } from '@dsh-trading/market-data'

/** Timeframes the panel offers; the provider may serve a subset and will say so. */
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const

/** Bars pulled per live refresh: the forming bar, plus a little overlap for a just-closed one. */
const TAIL_BARS = 3

/**
 * Live refresh cadence while the tape is moving.
 *
 * One second is affordable because the host answers from a warm series kept
 * current by Futu's own push — a refresh costs a local memory read, not a
 * broker request. Were this polling the broker per tick it would be both slow
 * and quota-hungry, which is exactly why the provider takes the push.
 */
const LIVE_MS = 1_000

/**
 * Cadence after the tape has gone quiet, or while the host reports the tab
 * unwatched. Kept close to the live cadence on purpose: a refresh is a local
 * memory read against a push-fed series, so backing off buys almost nothing
 * and costs responsiveness the moment the user looks back. This is a courtesy
 * to an idle machine, not a quota defence — the push already removed the quota
 * argument entirely.
 */
const IDLE_MS = 5_000

/** Unchanged polls before backing off. */
const QUIET_LIMIT = 8

/**
 * How often the panel re-asserts what it is showing, even when nothing changed.
 *
 * The host expires a view that stops being republished, which is how a tab
 * left open on another symbol stops speaking for the user. That only works if
 * a panel that IS being watched keeps saying so — including through a closed
 * market, when the payload never changes and the change-driven publication
 * would fall silent.
 */
const VIEW_HEARTBEAT_MS = 10_000

/** Settle time before following the conversation, so a burst of calls costs one fetch. */
const FOLLOW_SETTLE_MS = 400

/** Consecutive failed refreshes before the badge stops claiming the chart is live. */
const STALL_AFTER = 3

const PANEL_SHELL: CSSProperties = { padding: '10px 14px 14px', fontSize: 12, lineHeight: 1.5 }

const BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 14px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
  flexWrap: 'wrap',
}

const INPUT: CSSProperties = {
  flex: '1 1 120px',
  minWidth: 0,
  background: 'var(--dsw-alias-bg-l1, transparent)',
  color: 'inherit',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 12.5,
  fontFamily: 'inherit',
}

const SELECT_PROVIDER: CSSProperties = {
  background: 'var(--dsw-alias-bg-l1, transparent)',
  color: 'inherit',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
  borderRadius: 6,
  padding: '3px 6px',
  fontSize: 11.5,
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const PRESET_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 14px 6px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
  overflowX: 'auto',
  fontSize: 11.5,
}

const PRESET_BUTTON = (on: boolean): CSSProperties => ({
  background: on ? 'var(--dsw-alias-bg-l2, rgba(128,128,128,0.2))' : 'transparent',
  color: on ? 'var(--dsw-alias-text-1, inherit)' : 'var(--dsw-alias-text-3, rgba(128,128,128,0.85))',
  border: `1px solid ${on ? 'var(--dsw-alias-border-l3, rgba(128,128,128,0.6))' : 'var(--dsw-alias-border-l1, rgba(128,128,128,0.2))'}`,
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  cursor: 'pointer',
  fontWeight: on ? 600 : 400,
  whiteSpace: 'nowrap',
})

const PRESET_SYMBOLS = [
  { label: 'ETH', symbol: 'ETHUSDT' },
  { label: 'BTC', symbol: 'BTCUSDT' },
  { label: 'SOL', symbol: 'SOLUSDT' },
  { label: '上证', symbol: 'sh000001' },
  { label: '茅台', symbol: '600519' },
  { label: '平安', symbol: '000001' },
] as const

const TF_BUTTON = (on: boolean): CSSProperties => ({
  background: 'transparent',
  color: on ? 'var(--dsw-alias-text-1, inherit)' : 'var(--dsw-alias-text-3, rgba(128,128,128,0.9))',
  border: `1px solid ${on ? 'var(--dsw-alias-border-l3, rgba(128,128,128,0.6))' : 'transparent'}`,
  borderRadius: 5,
  padding: '2px 7px',
  fontSize: 11.5,
  cursor: 'pointer',
  fontWeight: on ? 600 : 400,
})

const NOTE: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center',
  height: '100%', padding: '0 24px', textAlign: 'center', fontSize: 13,
  color: 'var(--dsw-alias-text-3, rgba(128, 128, 128, 0.9))',
}

const BANNER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '6px 14px',
  fontSize: 11.5,
  background: 'var(--dsw-alias-bg-error, rgba(224, 86, 63, 0.12))',
  borderBottom: '1px solid var(--dsw-alias-border-error, rgba(224, 86, 63, 0.3))',
  zIndex: 10,
  flexShrink: 0,
}

export function formatChartError(raw: string): string {
  if (raw === 'fetch failed' || raw.includes('fetch failed') || raw.includes('ECONNRESET')) {
    return '行情接口连接失败 (fetch failed)：无法直连境外 Binance/OKX 行情服务器。若在境内使用，请开启网络代理/梯子；或点击下方【查看 A 股】免代理体验。'
  }
  return raw
}

function ChartErrorBanner({
  error,
  targetTimeframe,
  currentTimeframe,
  onRetry,
  onDismiss,
  onSwitchToCn,
  providerId,
}: {
  error: string
  targetTimeframe?: string | undefined
  currentTimeframe?: string | undefined
  onRetry: () => void
  onDismiss: () => void
  onSwitchToCn: () => void
  providerId?: string | undefined
}): JSX.Element {
  const isCn = providerId === 'cn'
  const isNetwork = error.includes('不可达') || error.includes('fetch failed') || error.includes('网络') || error.includes('超时')
  const displayMsg = formatChartError(error)
  return (
    <div style={BANNER} role="alert">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <span style={{ color: 'var(--dsw-alias-text-error, #e0563f)', fontWeight: 600, flexShrink: 0 }}>
          ⚠ {targetTimeframe && currentTimeframe && targetTimeframe !== currentTimeframe ? `切换到 ${targetTimeframe} 失败` : '加载失败'}:
        </span>
        <span
          style={{
            color: 'var(--dsw-alias-text-1, inherit)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={displayMsg}
        >
          {displayMsg}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {!isCn && isNetwork ? (
          <button
            type="button"
            style={{ ...TF_BUTTON(false), padding: '1px 6px', fontSize: 11, borderColor: 'var(--dsw-alias-border-l3, rgba(128,128,128,0.5))' }}
            onClick={onSwitchToCn}
            title="一键切换为国内免代理 A 股数据源"
          >
            切到 A 股源
          </button>
        ) : null}
        <button
          type="button"
          style={{ ...TF_BUTTON(true), padding: '1px 8px', fontSize: 11 }}
          onClick={onRetry}
          title="重新发起请求"
        >
          🔄 重试
        </button>
        <button
          type="button"
          style={{ ...TF_BUTTON(false), padding: '1px 5px', fontSize: 11 }}
          onClick={onDismiss}
          title="关闭警告信息"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

/** Positioning moves on minutes, and Binance's ratio stats are 5m buckets; faster polling buys nothing. */
const DERIV_MS = 30_000

const STRIP: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 16px',
  padding: '6px 14px',
  fontSize: 11.5,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--dsw-alias-text-3, rgba(128,128,128,0.9))',
  borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
}

const VALUE: CSSProperties = { color: 'var(--dsw-alias-text-1, inherit)', fontWeight: 600, marginLeft: 4 }

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 })

/** "+0.0078%" — funding is a tiny fraction; four decimals of percent is what venues print. */
export function formatFunding(rate: number): string {
  return `${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(4)}%`
}

/** "3h 07m" until settlement, "" once it has passed (the next poll brings the new time). */
export function formatCountdown(untilIso: string, now: number): string {
  const ms = Date.parse(untilIso) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const m = Math.floor(ms / 60_000)
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * Open interest, funding and long/short for the symbol on screen. Renders
 * nothing for a provider without futures data (CSV, equities); a failed fetch
 * says so instead of showing stale numbers as current.
 */
function DerivativesStrip({ market, symbol, providerId, live, onData, hoveredTime }: {
  market: MarketClient
  symbol: string
  providerId: string
  live: boolean
  onData?: (data: PanelDerivatives | null) => void
  hoveredTime?: number | null
}): JSX.Element | null {
  const [data, setData] = useState<PanelDerivatives | null | undefined>(undefined)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    if (providerId === 'cn') {
      setData(null)
      onData?.(null)
      setFailed(null)
      return
    }
    setData(undefined)
    onData?.(null)
    setFailed(null)
    const controller = new AbortController()
    const pull = (): void => {
      market.getDerivatives(symbol, providerId, controller.signal).then(
        d => {
          setData(d)
          onData?.(d)
          setFailed(null)
        },
        (e: unknown) => { if (!controller.signal.aborted) setFailed(e instanceof Error ? e.message : String(e)) },
      )
    }
    pull()
    const timer = live ? setInterval(pull, DERIV_MS) : undefined
    return () => {
      controller.abort()
      if (timer !== undefined) clearInterval(timer)
    }
  }, [market, symbol, providerId, live])

  // Crosshair hover: match corresponding historical bar from data.history
  const historyBar = useMemo(() => {
    if (!hoveredTime || !data?.history || data.history.length === 0) return null
    const sec = Math.floor(hoveredTime / 1000)
    return data.history.find(h => {
      const hSec = Math.floor(Date.parse(h.time) / 1000)
      return Math.abs(hSec - sec) < 300 // within 5m
    }) ?? null
  }, [hoveredTime, data])

  if (providerId === 'cn' || data === null) return null
  if (failed !== null && data === undefined) {
    // Don't guess the cause: a timeout and "no such perpetual" both land here. Show the real error.
    return <div style={STRIP} title={failed}>合约数据获取失败（{failed.slice(0, 80)}），{DERIV_MS / 1000}s 后重试</div>
  }

  const target = historyBar ? {
    source: data?.source ?? '',
    openInterest: historyBar.openInterest ?? data?.openInterest,
    openInterestValue: historyBar.openInterestValue ?? data?.openInterestValue,
    fundingRate: data?.fundingRate ?? null,
    nextFundingTime: data?.nextFundingTime ?? null,
    longShortRatio: historyBar.longShortRatio ?? data?.longShortRatio,
    takerBuySellRatio: historyBar.takerBuySellRatio ?? data?.takerBuySellRatio,
    time: historyBar.time,
    posture: historyBar.posture ?? data?.posture,
    topPositionRatio: historyBar.topPositionRatio ?? data?.topPositionRatio,
    crowdVsWhale: historyBar.crowdVsWhale ?? data?.crowdVsWhale,
    oiChangePct1h: data?.oiChangePct1h,
    priceChangePct1h: data?.priceChangePct1h,
    isHistorical: true,
  } : data

  const show = (v: number | null | undefined, f: (n: number) => string): string =>
    v === null || v === undefined ? '—' : f(v)
  const countdown = target?.nextFundingTime ? formatCountdown(target.nextFundingTime, Date.now()) : ''

  return (
    <div
      style={{ ...STRIP, opacity: failed !== null ? 0.5 : 1 }}
      title={failed !== null ? `刷新失败，显示的是旧数据：${failed}` : target ? `${target.source} USDT 永续 · ${new Date(target.time).toLocaleTimeString()}` : '加载中'}
    >
      {target ? <span>{target.source}</span> : null}
      {historyBar ? (
        <span style={{ background: 'rgba(255,167,38,0.2)', color: '#ffa726', padding: '0 4px', borderRadius: 3, fontWeight: 'bold' }}>
          K线 {new Date(historyBar.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      ) : null}
      <span>持仓量<span style={VALUE}>{show(target?.openInterest, n => compact.format(n))}</span></span>
      <span>持仓价值<span style={VALUE}>{show(target?.openInterestValue, n => `$${compact.format(n)}`)}</span></span>
      <span>
        资金费率<span style={VALUE}>{show(target?.fundingRate, formatFunding)}</span>
        {countdown !== '' ? <span style={{ marginLeft: 4 }}>{countdown}</span> : null}
      </span>
      <span title="全市场多空账户数比（散户多空意愿）">散户比<span style={VALUE}>{show(target?.longShortRatio, n => n.toFixed(2))}</span></span>
      {target?.topPositionRatio !== null && target?.topPositionRatio !== undefined ? (
        <span title="排名前20%大户的持仓量多空比（大户真实多空持仓）">大户持仓比<span style={VALUE}>{show(target.topPositionRatio, n => n.toFixed(2))}</span></span>
      ) : null}
      <span title="最近 5 分钟主动买入量 / 主动卖出量">主动买卖比<span style={VALUE}>{show(target?.takerBuySellRatio, n => n.toFixed(2))}</span></span>
      {target?.posture ? (
        <span
          title={historyBar ? `该时刻持仓动向: ${target.posture}` : `近1小时: 价格 ${target.priceChangePct1h !== null && target.priceChangePct1h !== undefined ? (target.priceChangePct1h > 0 ? '+' : '') + target.priceChangePct1h.toFixed(2) + '%' : '—'}，持仓 ${target.oiChangePct1h !== null && target.oiChangePct1h !== undefined ? (target.oiChangePct1h > 0 ? '+' : '') + target.oiChangePct1h.toFixed(2) + '%' : '—'}`}
          style={{
            fontWeight: 600,
            padding: '0 4px',
            borderRadius: 3,
            background: postureColor(target.posture).bg,
            color: postureColor(target.posture).color,
          }}
        >
          {target.posture}
          {!historyBar && target.oiChangePct1h !== null && target.oiChangePct1h !== undefined ? (
            <span style={{ fontSize: 10, marginLeft: 3, opacity: 0.85 }}>
              (仓{target.oiChangePct1h > 0 ? '+' : ''}{target.oiChangePct1h.toFixed(1)}%{target.priceChangePct1h !== null && target.priceChangePct1h !== undefined ? ` 价${target.priceChangePct1h > 0 ? '+' : ''}${target.priceChangePct1h.toFixed(1)}%` : ''})
            </span>
          ) : null}
        </span>
      ) : null}
      {target?.crowdVsWhale ? (
        <span
          title="散户多空人数比与大户持仓资金比背离诊断"
          style={{
            fontSize: 10.5,
            padding: '1px 5px',
            borderRadius: 3,
            background: 'rgba(255,167,38,0.15)',
            color: '#ffa726',
            fontWeight: 500,
          }}
        >
          {target.crowdVsWhale}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Institutional & retail capital flow strip for A-shares / equities.
 * Displays: 主力净流入 (superLarge + large), 超大单, 大单, 散户 (medium + small), 主力净买占比.
 */
function MoneyFlowStrip({ market, symbol, providerId, live }: {
  market: MarketClient
  symbol: string
  providerId: string
  live: boolean
}): JSX.Element | null {
  const [data, setData] = useState<PanelMoneyFlow | null | undefined>(undefined)

  useEffect(() => {
    if (providerId !== 'cn') {
      setData(null)
      return
    }
    setData(undefined)
    const controller = new AbortController()
    const pull = (): void => {
      market.getMoneyFlow(symbol, providerId, controller.signal).then(
        mf => setData(mf),
        () => { if (!controller.signal.aborted) setData(null) },
      )
    }
    pull()
    const timer = live ? setInterval(pull, DERIV_MS) : undefined
    return () => {
      controller.abort()
      if (timer !== undefined) clearInterval(timer)
    }
  }, [market, symbol, providerId, live])

  if (providerId !== 'cn' || !data) return null

  const mainColor = data.netInflow >= 0 ? '#3ddc97' : '#f47067'
  const fmt = (v?: number | null) => {
    if (v === undefined || v === null) return '—'
    const abs = Math.abs(v)
    const sign = v >= 0 ? '+' : '-'
    if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`
    if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}万`
    return `${sign}${abs.toFixed(0)}元`
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '3px 12px',
        fontSize: 11,
        borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.06))',
        background: 'var(--dsw-alias-bg-subtle, rgba(255,255,255,0.02))',
        fontVariantNumeric: 'tabular-nums',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontWeight: 600, color: 'var(--dsw-alias-text-primary, #e6edf3)' }}>
        资金流向:
      </span>
      <span>
        主力净流入 <strong style={{ color: mainColor }}>{fmt(data.netInflow)}</strong>
        {data.mainRatioPct !== undefined && data.mainRatioPct !== null
          ? <span style={{ color: mainColor, marginLeft: 3 }}>({data.mainRatioPct >= 0 ? '+' : ''}{data.mainRatioPct}%)</span>
          : null}
      </span>
      {data.superLargeInflow !== undefined && data.superLargeInflow !== null ? (
        <span style={{ opacity: 0.85 }}>
          超大单 <span style={{ color: data.superLargeInflow >= 0 ? '#3ddc97' : '#f47067' }}>{fmt(data.superLargeInflow)}</span>
        </span>
      ) : null}
      {data.largeInflow !== undefined && data.largeInflow !== null ? (
        <span style={{ opacity: 0.85 }}>
          大单 <span style={{ color: data.largeInflow >= 0 ? '#3ddc97' : '#f47067' }}>{fmt(data.largeInflow)}</span>
        </span>
      ) : null}
      {data.smallInflow != null && data.mediumInflow != null ? (
        <span style={{ opacity: 0.85 }}>
          散户(中小单) <span style={{ color: data.smallInflow + data.mediumInflow >= 0 ? '#3ddc97' : '#f47067' }}>{fmt(data.smallInflow + data.mediumInflow)}</span>
        </span>
      ) : null}
    </div>
  )
}

/**
 * Level 2 Orderbook depth strip (买一至买五、卖一至卖五、买卖价差与委比).
 */
function OrderbookStrip({ market, symbol, providerId, live }: {
  market: MarketClient
  symbol: string
  providerId: string
  live: boolean
}): JSX.Element | null {
  const [data, setData] = useState<Orderbook | null | undefined>(undefined)

  useEffect(() => {
    setData(undefined)
    const controller = new AbortController()
    const pull = (): void => {
      market.getOrderbook(symbol, providerId, controller.signal).then(
        ob => setData(ob),
        () => { if (!controller.signal.aborted) setData(null) },
      )
    }
    pull()
    const timer = live ? setInterval(pull, 3_000) : undefined
    return () => {
      controller.abort()
      if (timer !== undefined) clearInterval(timer)
    }
  }, [market, symbol, providerId, live])

  if (!data || (data.bids.length === 0 && data.asks.length === 0)) return null

  const bestBid = data.bids[0]
  const bestAsk = data.asks[0]
  const spread = data.spread ?? (bestBid && bestAsk ? Number((bestAsk.price - bestBid.price).toFixed(4)) : null)

  return (
    <div style={{ ...STRIP, fontSize: 11, background: 'var(--dsw-alias-bg-hover, rgba(128,128,128,0.04))' }}>
      <span style={{ color: 'var(--dsw-alias-text-brand, #3370ff)', fontWeight: 600 }}>
        盘口五档 (L2):
      </span>
      {bestBid ? (
        <span>
          买一: <strong style={{ color: '#3ddc97' }}>{bestBid.price}</strong> ({bestBid.quantity}手)
        </span>
      ) : null}
      {bestAsk ? (
        <span>
          卖一: <strong style={{ color: '#f47067' }}>{bestAsk.price}</strong> ({bestAsk.quantity}手)
        </span>
      ) : null}
      {spread !== null ? (
        <span style={{ opacity: 0.85 }}>
          价差: <span style={{ color: 'var(--dsw-alias-text-1, inherit)' }}>{spread}</span>
        </span>
      ) : null}
      {data.bids.length > 1 || data.asks.length > 1 ? (
        <span style={{ opacity: 0.85 }}>
          买档: {data.bids.slice(0, 3).map(b => `${b.price}`).join('/')} | 卖档: {data.asks.slice(0, 3).map(a => `${a.price}`).join('/')}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Stock valuation & fundamentals metrics strip (PE TTM, PB, 总市值, 流通市值).
 */
function FundamentalsStrip({ market, symbol, providerId }: {
  market: MarketClient
  symbol: string
  providerId: string
}): JSX.Element | null {
  const [data, setData] = useState<FundamentalsPackage | null | undefined>(undefined)

  useEffect(() => {
    setData(undefined)
    const controller = new AbortController()
    market.getFundamentals(symbol, providerId, controller.signal).then(
      f => setData(f),
      () => { if (!controller.signal.aborted) setData(null) },
    )
    return () => {
      controller.abort()
    }
  }, [market, symbol, providerId])

  if (!data) return null

  const fmtCap = (v?: number) => {
    if (v === undefined || v === null || Number.isNaN(v)) return '—'
    if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
    if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`
    return `${v.toFixed(0)}元`
  }

  return (
    <div style={{ ...STRIP, fontSize: 11 }}>
      <span style={{ color: 'var(--dsw-alias-text-brand, #8b5cf6)', fontWeight: 600 }}>
        估值基本面:
      </span>
      {data.peTtm !== undefined && data.peTtm !== null ? (
        <span>
          市盈率(TTM): <strong>{data.peTtm.toFixed(2)}</strong>
        </span>
      ) : null}
      {data.pb !== undefined && data.pb !== null ? (
        <span>
          市净率(PB): <strong>{data.pb.toFixed(2)}</strong>
        </span>
      ) : null}
      {data.marketCap !== undefined && data.marketCap !== null ? (
        <span>
          总市值: <strong>{fmtCap(data.marketCap)}</strong>
        </span>
      ) : null}
      {data.circulatingMarketCap !== undefined && data.circulatingMarketCap !== null ? (
        <span>
          流通市值: <strong>{fmtCap(data.circulatingMarketCap)}</strong>
        </span>
      ) : null}
      {data.turnoverRatio !== undefined && data.turnoverRatio !== null ? (
        <span>
          换手率: <strong>{data.turnoverRatio.toFixed(2)}%</strong>
        </span>
      ) : null}
    </div>
  )
}

/** What the plugin's inject face hands this component. */
export interface ChartPanelInject {
  market: MarketClient
}

/**
 * The chart column body.
 * @param width - resolved column width; 0 means the frame closed the column.
 *   The subtree stays MOUNTED at width 0 so state survives reopening, so the
 *   panel must decline to render — initialising a chart into a zero-width
 *   container burns a canvas nobody can see.
 * @param market - the host-backed data client.
 * @returns the chart, or an invitation to name a symbol.
 */
function ChartPanelInner({ width, market }: ChartOwnerProps & ChartPanelInject): JSX.Element | null {
  const fromAgent = useSyncExternalStore(subscribeLatestChart, getLatestChart, getLatestChart)

  const [draft, setDraft] = useState('')
  const [timeframe, setTimeframe] = useState<string>('1d')
  const [own, setOwn] = useState<ChartPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [tick, setTick] = useState<string | null>(null)
  // Seeded from this tab's memory: see rememberMarks. Without it a reload
  // loses the drawing whenever the card that produced it has scrolled out of
  // the conversation and no longer renders.
  const [marks, setMarks] = useState<ChartMarks | null>(recallMarks)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [availableProviders, setAvailableProviders] = useState<{ id: string; description: string }[]>([
    { id: 'binance', description: 'Binance' },
    { id: 'cn', description: '东财/新浪 A股' },
  ])
  const [manualProvider, setManualProvider] = useState<string>(() => {
    try {
      return localStorage.getItem('dsh-trading.manual-provider') || 'auto'
    } catch {
      return 'auto'
    }
  })
  const [watchlist, setWatchlist] = useState<{ items: { symbol: string; group: string; notes?: string }[]; groups: string[] } | null>(null)
  const [activeGroup, setActiveGroup] = useState<string>('全部')
  const [panelDerivatives, setPanelDerivatives] = useState<PanelDerivatives | null>(null)
  const [hoveredTime, setHoveredTime] = useState<number | null>(null)
  const followTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inflight = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const quiet = useRef(0)
  const fails = useRef(0)
  const failedFollow = useRef<string | null>(null)
  const ownOrigin = useRef<'user' | 'followed'>('user')

  useEffect(() => {
    let active = true
    market.listProviders?.()
      .then(list => {
        if (active && Array.isArray(list) && list.length > 0) {
          setAvailableProviders(list)
        }
      })
      .catch(() => {})
    return () => { active = false }
  }, [market])

  // Dynamically load user watchlist from @dsh-trading/watchlist
  useEffect(() => {
    let active = true
    if (typeof market.getWatchlist === 'function') {
      market.getWatchlist().then(
        data => {
          if (active && data && Array.isArray(data.items) && data.items.length > 0) {
            setWatchlist(data)
          }
        },
        () => {},
      )
    }
    return () => { active = false }
  }, [market])

  // Adopt whatever the agent last DREW, separately from what it last fetched.
  // Keyed on content, not identity: `latest` republishes the same payload
  // whenever an old card scrolls back into view, and an identical republish
  // must not disturb the chart or re-arm a dismissal.
  useEffect(() => {
    const next = readMarks(fromAgent)
    if (next === null) return
    setMarks(cur => {
      if (cur !== null && cur.key === next.key) return cur
      rememberMarks(next)
      // A dismissal is about the marks that were on screen when it was
      // clicked, not a standing veto. Without this, adopting a different set
      // while an old key is dismissed hides the pill too — and with the pill
      // goes the only way back to the drawing.
      setDismissed(null)
      return next
    })
  }, [fromAgent])

  const active = marks !== null && marks.key !== dismissed ? marks : null
  const merged = useMemo(
    () => own !== null && active !== null ? mergeMarks(own, active) : null,
    [own, active],
  )

  // The panel's own lookup takes precedence: an agent answer arriving mid-read
  // must not replace what the user deliberately put on screen. Its DRAWINGS
  // are welcome on top of it, which is what `merged` carries; when they are
  // about a different chart, mergeMarks hands the payload straight back.
  const payload = merged?.payload ?? own ?? fromAgent

  const load = useCallback(async (
    symbol: string,
    tf: string,
    trigger: 'user' | 'follow' = 'user',
    forcedProvider?: string,
  ) => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setBusy(true)
    if (trigger === 'user') setError(null)
    failedFollow.current = null
    // A deliberate lookup is a fresh start for the live loop: the quiet streak
    // belongs to the series that earned it, so carrying it across a symbol or
    // timeframe change would leave a moving instrument stuck at the idle
    // cadence it inherited from a closed one.
    quiet.current = 0
    try {
      const pId = forcedProvider !== undefined
        ? (forcedProvider === 'auto' ? undefined : forcedProvider)
        : (manualProvider === 'auto' ? undefined : manualProvider)
      const next = await market.getPayload(symbol, tf, pId, controller.signal)
      if (!controller.signal.aborted) {
        setOwn(next)
        ownOrigin.current = trigger === 'user' ? 'user' : 'followed'
        // Always clear a stale error on success, whoever asked. `error`
        // outranks the chart in the render ladder, so leaving one set would
        // hide the chart a followed load just put on screen — with no control
        // anywhere to dismiss it.
        setError(null)
        fails.current = 0
        setStalled(false)
      }
    } catch (cause) {
      // A followed load leaves whatever is on screen alone: `error` outranks
      // the chart in the render ladder, so a transient failure would replace a
      // good chart with red text nobody asked for.
      if (!controller.signal.aborted) {
        if (trigger === 'user') setError(cause instanceof Error ? cause.message : String(cause))
        // Remember a target the conversation asked for and the provider
        // refused. The follow effect re-runs on every `own` identity change —
        // and the live tail mints one per price tick — so without this the
        // panel refetches the same failing symbol for as long as the tape
        // moves, silently, forever.
        else failedFollow.current = `${symbol}|${tf}`
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [market, manualProvider])

  // Follow the conversation. The agent's payload is a frozen <=200-bar
  // snapshot and the live loop only runs on a series the panel fetched itself,
  // so adopting it verbatim gives a chart that never moves — the reported
  // symptom. Instead the panel loads that instrument and interval as ITS OWN
  // series: live, full depth, and the marks then match by construction.
  //
  // Debounced because an analysis can call annotate_chart dozens of times in
  // one turn; only the settled target is worth a fetch.
  useEffect(() => {
    const decision = decideFollow(
      fromAgent === null
        ? null
        : { symbol: fromAgent.symbol, timeframe: fromAgent.timeframes[0]?.timeframe },
      {
        width,
        pinned,
        own: own === null ? null : { symbol: own.symbol, timeframe: own.timeframes[0]?.timeframe },
      },
    )
    if (decision.action !== 'load') return
    if (failedFollow.current === `${decision.symbol}|${decision.timeframe}`) return

    clearTimeout(followTimer.current)
    followTimer.current = setTimeout(() => {
      setTimeframe(decision.timeframe)
      void load(decision.symbol, decision.timeframe, 'follow')
    }, FOLLOW_SETTLE_MS)
    return () => clearTimeout(followTimer.current)
  }, [fromAgent, own, pinned, width, load])

  // One symbols probe on mount, purely to tell the user what this provider
  // actually carries — a wrong-format symbol is the likeliest first mistake.
  useEffect(() => {
    let live = true
    market.listSymbols()
      .then(({ description, symbols }) => {
        if (!live) return
        const sample = symbols.slice(0, 4).map(s => s.symbol).join(' · ')
        setHint(symbols.length === 0 ? description : `${description} — e.g. ${sample}`)
      })
      .catch(() => { /* the input still works; the hint is a courtesy */ })
    return () => { live = false }
  }, [market])

  useEffect(() => () => inflight.current?.abort(), [])

  // Mirror the instrument on screen into the input, so the box is never empty
  // under a chart and a submit means "reload what I am looking at". Skipped
  // while the field has focus — the user's half-typed symbol outranks this.
  const shownRef = useRef<string | null>(null)
  useEffect(() => {
    const shown = payload?.symbol?.trim() ?? ''
    if (shown === '' || shown === shownRef.current) return
    // Record only what was actually mirrored. Marking a symbol as done while
    // the field had focus left the box stuck on the previous instrument for
    // good, because the guard above then short-circuits every later run.
    if (document.activeElement === inputRef.current) return
    shownRef.current = shown
    setDraft(shown)
  }, [payload])

  // Publish what is on screen. The panel's data path deliberately bypasses the
  // tool layer, which means nothing about this chart reaches the model on its
  // own — without this the agent asks the user to screenshot a chart it is
  // rendering two columns away.
  useEffect(() => {
    if (payload === null || width === 0) return
    const tf = payload.timeframes[0]
    if (tf === undefined) return
    const publish = (): void => {
      const candles = tf.candles
      const first = candles[0]
      const last = candles[candles.length - 1]
      market.publishView({
        symbol: payload.symbol,
        timeframe: tf.timeframe,
        bars: candles.length,
        from: first?.time,
        to: last?.time,
        close: last?.close,
        // Effective liveness, not the toggle: a stalled column is not
        // refreshing, and saying otherwise makes the model vouch for a frozen
        // chart's freshness.
        live: live && !stalled,
        origin: own === null ? 'agent' : ownOrigin.current === 'user' ? 'user' : 'followed',
        // Whether the agent's drawings actually landed is the one thing it
        // cannot infer: annotate_chart returning successfully says nothing
        // about what this column decided to render.
        ...merged?.applied === true && merged.kept > 0
          ? {
              marks: merged.kept,
              marksDropped: merged.dropped,
              ...active !== null ? { marksTimeframe: active.timeframe } : {},
            }
          : {},
      })
    }
    publish()
    const beat = setInterval(publish, VIEW_HEARTBEAT_MS)
    return () => clearInterval(beat)
  }, [payload, width, live, own, market, merged, active])

  // Live tail. Deliberately a poll rather than a push: the host channel is
  // unary, and a chart that is at most a few seconds stale is worth far less
  // engineering than a streaming transport. Only the last few bars move, so
  // each refresh is a few hundred bytes.
  //
  // Gated on the column being open. Tab visibility only SLOWS the loop, it
  // never stops it: embedding surfaces (an in-app browser pane, a background
  // preview) report `hidden` while the user is plainly looking at them, and a
  // liveness feature that silently dies on a host's misreport is worse than
  // one that occasionally polls a tab nobody is reading.
  useEffect(() => {
    if (!live || own === null || width === 0) return
    const symbol = own.symbol
    const tf = own.timeframes[0]?.timeframe
    if (tf === undefined) return

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    const pump = async (): Promise<void> => {
      if (stopped) return
      try {
        const pId = manualProvider === 'auto' ? own.provider : manualProvider
        const tail = await market.getTail(symbol, tf, TAIL_BARS, pId, controller.signal)
        if (stopped) return
        // A refresh that succeeded is the end of a stall, whether or not the
        // bars moved: on a closed tape every poll returns the same series, and
        // clearing only on movement latched the warning on for the session.
        // Also keeps setStalled out of the updater below — React invokes those
        // during render, twice under StrictMode.
        fails.current = 0
        setStalled(false)
        setOwn(current => {
          if (current === null) return current
          const series = current.timeframes[0]?.candles ?? []
          const nextSeries = mergeTail(series, tail)
          if (nextSeries === series) {
            quiet.current += 1
            return current
          }
          quiet.current = 0
          setTick(new Date().toLocaleTimeString())
          return withCandles(current, nextSeries)
        })
      } catch {
        // A transient hiccup must not kill the loop or replace a good chart
        // with an error — but a SUSTAINED one must not keep claiming "Live"
        // over a frozen chart either. That combination is what makes a dead
        // transport look like a broken feature.
        quiet.current += 1
        fails.current += 1
        if (fails.current >= STALL_AFTER) setStalled(true)
      }
      const quietly = quiet.current >= QUIET_LIMIT
      const unwatched = document.visibilityState !== 'visible'
      schedule(quietly || unwatched ? IDLE_MS : LIVE_MS)
    }

    function schedule(ms: number): void {
      if (!stopped) timer = setTimeout(() => void pump(), ms)
    }

    schedule(LIVE_MS)
    return () => {
      stopped = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [live, own, width, market, manualProvider])

  if (width === 0) return null

  // What the toolbar describes is what is ON SCREEN — which is not always what
  // the user typed. A chart the agent produced arrives with `own` null and the
  // input still empty, and reading the controls off `draft` alone left the
  // timeframe buttons inert (no symbol to reload) while highlighting a period
  // the chart was not even drawn on.
  const shownSymbol = (payload?.symbol ?? '').trim()
  const shownTimeframe = payload?.timeframes[0]?.timeframe
  // A period the user just clicked wins until its data lands. Reading the
  // highlight off the payload alone meant a click gave no feedback while the
  // fetch was in flight, and was silently discarded if the fetch failed — the
  // next submit would then use a period the toolbar was no longer showing.
  const activeTimeframe = busy || error !== null ? timeframe : shownTimeframe ?? timeframe

  const isCurrentInWatchlist = useMemo(() => {
    if (!shownSymbol || !watchlist?.items) return false
    const sym = shownSymbol.toUpperCase()
    return watchlist.items.some(it => it.symbol.toUpperCase() === sym)
  }, [shownSymbol, watchlist])

  const toggleCurrentWatchlist = useCallback(async () => {
    if (!shownSymbol) return
    const sym = shownSymbol.toUpperCase()
    if (isCurrentInWatchlist) {
      if (typeof market.removeFromWatchlist === 'function') {
        await market.removeFromWatchlist(sym).catch(() => {})
      }
      setWatchlist(prev => prev ? { ...prev, items: prev.items.filter(it => it.symbol.toUpperCase() !== sym) } : null)
    } else {
      const group = activeGroup !== '全部' ? activeGroup : '自选'
      if (typeof market.addToWatchlist === 'function') {
        await market.addToWatchlist(sym, group).catch(() => {})
      }
      setWatchlist(prev => {
        if (!prev) return { groups: [group], items: [{ symbol: sym, group }] }
        const nextGroups = prev.groups.includes(group) ? prev.groups : [...prev.groups, group]
        return { groups: nextGroups, items: [...prev.items, { symbol: sym, group }] }
      })
    }
  }, [shownSymbol, isCurrentInWatchlist, market, activeGroup])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const symbol = draft.trim()
    if (symbol === '') return
    setPinned(true)
    void load(symbol, activeTimeframe)
  }

  const pickTimeframe = (tf: string): void => {
    setPinned(true)
    setTimeframe(tf)
    // Prefer the symbol on screen over the draft: switching the period of a
    // chart the agent put up is the commonest reason to touch these buttons.
    const symbol = (draft.trim() !== '' ? draft : shownSymbol).trim()
    if (symbol !== '') void load(symbol, tf)
  }

  const changeProvider = (newProvider: string): void => {
    setManualProvider(newProvider)
    try {
      localStorage.setItem('dsh-trading.manual-provider', newProvider)
    } catch {}
    let targetSymbol = (draft.trim() !== '' ? draft : shownSymbol).trim()
    if (newProvider === 'cn' && (!targetSymbol || /^[A-Z]{3,10}(USDT|BUSD|USDC|BTC|ETH)$/i.test(targetSymbol))) {
      targetSymbol = 'sh000001'
      setDraft('sh000001')
    } else if (newProvider === 'binance' && (!targetSymbol || /^(sh|sz)?\d{6}$/i.test(targetSymbol))) {
      targetSymbol = 'ETHUSDT'
      setDraft('ETHUSDT')
    }
    if (targetSymbol !== '') {
      setPinned(true)
      void load(targetSymbol, activeTimeframe, 'user', newProvider)
    }
  }

  const pickPreset = (sym: string): void => {
    setPinned(true)
    setDraft(sym)
    void load(sym, activeTimeframe, 'user')
  }

  // The agent's drawings, and what to do about them. Suppressed while the body
  // is showing a loading or error screen: `own` survives a failed lookup, so a
  // pill there would claim marks over an error message.
  const showPill = active !== null && own !== null && error === null && !(busy && payload === null)
  // Scenarios draw their own trigger/invalidation lines, so a scenario-only
  // analysis is not "0 marks".
  const markCount = active === null ? 0 : active.annotations.length + active.scenarios.length
  const offerable = active !== null
    && TIMEFRAMES.includes(active.timeframe as (typeof TIMEFRAMES)[number])
    && own?.provider === active.provider
  const marksPill = !showPill || active === null ? null : (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {merged?.applied === true
        ? (
          <span
            style={{ ...TF_BUTTON(true), cursor: 'default' }}
            title={
              `AI 在 ${active.timeframe} 分析中画的标注。`
              + (merged.dropped > 0
                ? ` 其中 ${merged.dropped} 条超出当前窗口的价格或时间范围，未显示。`
                : '')
            }
          >
            ✎ {merged.kept} 条标注 · {active.timeframe} · {active.at}
            {merged.dropped > 0 ? ` · ${merged.dropped} 条在窗口外` : ''}
          </span>
        )
        : offerable
          ? (
            <button
              type="button"
              style={TF_BUTTON(false)}
              title={`AI 在 ${active.rawSymbol} ${active.timeframe} 上画了标注，点击在这里加载查看。`}
              onClick={() => {
                // Taking the agent's marked-up chart IS the user taking the
                // wheel — same as submitting a symbol or picking a period.
                // Left unpinned, the follow effect drags the column back to
                // whatever the conversation last charted 400ms later, so the
                // button could never actually land anywhere.
                setPinned(true)
                setDraft(active.rawSymbol)
                setTimeframe(active.timeframe)
                void load(active.rawSymbol, active.timeframe)
              }}
            >
              ✎ {active.rawSymbol} {active.timeframe} · {markCount} 条标注 — 查看
            </button>
          )
          : (
            <span
              style={{ ...TF_BUTTON(false), cursor: 'default' }}
              title={
                `AI 在 ${active.rawSymbol} ${active.timeframe} 上画了标注，本面板无法加载`
                + `（数据源不同，或周期不在可选范围内）。`
              }
            >
              ✎ {active.rawSymbol} {active.timeframe} · 不在本图
            </span>
          )}
      <button
        type="button"
        style={{ ...TF_BUTTON(false), padding: '2px 5px' }}
        title="隐藏 AI 标注，直到它画新的"
        onClick={() => setDismissed(active.key)}
      >
        ×
      </button>
    </span>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <form style={BAR} onSubmit={submit}>
        <input
          ref={inputRef}
          style={INPUT}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="代码，如 ETHUSDT"
          aria-label="图表代码"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <select
          style={SELECT_PROVIDER}
          value={manualProvider}
          onChange={e => changeProvider(e.target.value)}
          title="选择数据源 (自动根据代码分流，或手动强制指定)"
          aria-label="数据源选择"
        >
          <option value="auto">源: 自动</option>
          {availableProviders.map(p => (
            <option key={p.id} value={p.id}>
              源: {p.id === 'binance' ? 'Binance' : p.id === 'cn' ? '东财/新浪A股' : p.description || p.id}
            </option>
          ))}
        </select>
        {TIMEFRAMES.map(tf => (
          <button key={tf} type="button" style={TF_BUTTON(tf === activeTimeframe)} onClick={() => pickTimeframe(tf)}>
            {tf}
          </button>
        ))}
        {pinned
          ? (
            <button
              type="button"
              style={TF_BUTTON(false)}
              title="已固定：图表不再跟随对话切换。点击恢复跟随。"
              onClick={() => setPinned(false)}
            >
              📌 已固定
            </button>
          )
          : null}
        {marksPill}
        <button
          type="button"
          style={{ ...TF_BUTTON(live), marginLeft: 'auto' }}
          onClick={() => setLive(v => !v)}
          aria-pressed={live}
          title={
            !live ? '实时刷新已暂停'
              : own === null ? '还没从数据源加载图表，输入代码后开始实时刷新。'
              : stalled ? '刷新连续失败，图表没有在动。持续如此请刷新页面。'
                : '实时刷新中，点击暂停'
          }
        >
          {/* The poll only runs on a series the panel fetched itself (own); without one, "Live" would be a lie. */}
          {!live ? '❙❙ 已暂停' : own === null ? '○ 未实时' : stalled ? '⚠ 卡住' : `● 实时${tick !== null ? ` ${tick}` : ''}`}
        </button>
      </form>

      <div style={PRESET_ROW}>
        <span style={{ color: 'var(--dsw-alias-text-3, rgba(128,128,128,0.75))', whiteSpace: 'nowrap' }}>
          {watchlist && watchlist.items.length > 0 ? '自选:' : '热门:'}
        </span>
        {watchlist && watchlist.groups && watchlist.groups.length > 1 ? (
          <select
            value={activeGroup}
            onChange={e => setActiveGroup(e.target.value)}
            style={{
              background: 'transparent',
              color: 'var(--dsw-alias-text-2, inherit)',
              border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
              borderRadius: 4,
              fontSize: 11,
              padding: '1px 4px',
              cursor: 'pointer',
              marginRight: 4,
            }}
          >
            <option value="全部">全部分组</option>
            {watchlist.groups.map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        ) : null}
        {(watchlist && watchlist.items.length > 0
          ? watchlist.items
              .filter(item => activeGroup === '全部' || item.group === activeGroup)
              .map(item => ({
                label: item.notes || item.symbol,
                symbol: item.symbol,
                tooltip: `${item.symbol} [${item.group}]${item.notes ? ` · ${item.notes}` : ''}`,
              }))
          : PRESET_SYMBOLS.map(item => ({
              label: item.label,
              symbol: item.symbol,
              tooltip: `快速切换到 ${item.label} (${item.symbol})`,
            }))
        ).map(item => {
          const isCurrent = (shownSymbol.toUpperCase() === item.symbol.toUpperCase()) || (draft.trim().toUpperCase() === item.symbol.toUpperCase())
          return (
            <button
              key={item.symbol}
              type="button"
              style={PRESET_BUTTON(isCurrent)}
              onClick={() => pickPreset(item.symbol)}
              title={item.tooltip}
            >
              {item.label}
            </button>
          )
        })}
        {shownSymbol ? (
          <button
            type="button"
            style={{
              background: isCurrentInWatchlist ? 'rgba(234, 179, 8, 0.15)' : 'transparent',
              color: isCurrentInWatchlist ? '#eab308' : 'var(--dsw-alias-text-3, rgba(128,128,128,0.75))',
              border: isCurrentInWatchlist ? '1px solid rgba(234, 179, 8, 0.4)' : '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
              borderRadius: 4,
              fontSize: 11,
              padding: '1px 6px',
              cursor: 'pointer',
              marginLeft: 'auto',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
            }}
            onClick={toggleCurrentWatchlist}
            title={isCurrentInWatchlist ? `点击将 ${shownSymbol} 移出自选` : `点击将 ${shownSymbol} 加入自选`}
          >
            {isCurrentInWatchlist ? '★ 已自选' : '☆ +自选'}
          </button>
        ) : null}
      </div>

      {payload !== null && shownSymbol !== ''
        ? (
          <>
            {payload.provider !== 'cn' ? (
              <DerivativesStrip
                key={`deriv-${payload.provider}`}
                market={market}
                symbol={shownSymbol}
                providerId={payload.provider}
                live={live}
                onData={setPanelDerivatives}
                hoveredTime={hoveredTime}
              />
            ) : null}
            {payload.provider === 'cn' ? (
              <MoneyFlowStrip
                key="moneyflow-cn"
                market={market}
                symbol={shownSymbol}
                providerId={payload.provider}
                live={live}
              />
            ) : null}
            {payload.provider === 'cn' ? (
              <OrderbookStrip
                key={`orderbook-${payload.provider}-${shownSymbol}`}
                market={market}
                symbol={shownSymbol}
                providerId={payload.provider}
                live={live}
              />
            ) : null}
            {payload.provider === 'cn' ? (
              <FundamentalsStrip
                key={`fundamentals-${payload.provider}-${shownSymbol}`}
                market={market}
                symbol={shownSymbol}
                providerId={payload.provider}
              />
            ) : null}
          </>
        )
        : null}

      {error !== null && payload !== null ? (
        <ChartErrorBanner
          error={error}
          targetTimeframe={timeframe}
          currentTimeframe={shownTimeframe}
          onRetry={() => {
            const sym = (draft.trim() !== '' ? draft : shownSymbol).trim()
            if (sym !== '') void load(sym, activeTimeframe, 'user')
          }}
          onDismiss={() => {
            setError(null)
            if (shownTimeframe) setTimeframe(shownTimeframe)
          }}
          onSwitchToCn={() => changeProvider('cn')}
          providerId={payload.provider}
        />
      ) : null}

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {busy && payload === null
          ? <div style={NOTE}><p>加载中…</p></div>
          : error !== null && payload === null
            ? (
              <div style={NOTE}>
                <p style={{ color: 'var(--dsw-alias-text-error, #e0563f)', fontWeight: 600, maxWidth: 520, lineHeight: 1.6, margin: '0 auto' }}>
                  {formatChartError(error)}
                </p>
                <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={{ ...TF_BUTTON(true), padding: '4px 14px' }}
                    onClick={() => {
                      const sym = (draft.trim() !== '' ? draft : shownSymbol).trim()
                      if (sym !== '') void load(sym, activeTimeframe, 'user')
                    }}
                  >
                    🔄 重新加载
                  </button>
                  <button
                    type="button"
                    style={{ ...TF_BUTTON(false), padding: '4px 14px' }}
                    onClick={() => pickPreset('sh000001')}
                  >
                    🇨🇳 查看上证指数 (免代理)
                  </button>
                  <button
                    type="button"
                    style={{ ...TF_BUTTON(false), padding: '4px 14px' }}
                    onClick={() => pickPreset('600519')}
                  >
                    🇨🇳 查看贵州茅台 (免代理)
                  </button>
                </div>
                {hint !== null ? <p style={{ fontSize: 12, opacity: 0.75, marginTop: 10 }}>{hint}</p> : null}
              </div>
            )
            : payload !== null
              ? (
                <ChartErrorBoundary>
                  <ChartBody payload={payload} shell={PANEL_SHELL} fill prose={false} derivatives={panelDerivatives} onCrosshairHover={setHoveredTime} />
                </ChartErrorBoundary>
              )
              : (
                <div style={NOTE}>
                  <p>在上方输入代码，或让 AI 帮你打开。</p>
                  {hint !== null ? <p style={{ fontSize: 12, opacity: 0.75 }}>{hint}</p> : null}
                </div>
              )}
      </div>
    </div>
  )
}

export function ChartPanel(props: ChartOwnerProps & ChartPanelInject): JSX.Element {
  return (
    <ChartErrorBoundary>
      <ChartPanelInner {...props} />
    </ChartErrorBoundary>
  )
}
