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
import { ChartBody, ChartErrorBoundary, peekSettings, subscribeSettings } from './ChartCard.js'
import type { ChartHistory } from './ChartCard.js'
import { derivativesForTime } from './market-client.js'
import { getLatestChart, subscribeLatestChart } from './latest.js'
import { decideFollow } from './follow.js'
import { combineMarks, filterWallsByMarket, isSpotWallMarket, mergeMarks, mergeTail, PANEL_TIMEFRAMES, postureColor, readMarks, recallMarks, rememberMarks, timeframesForSource, withCandles } from './market-client.js'
import type { ChartMarks, MarketClient, PanelDerivatives, PanelLargeOrders, PanelMoneyFlow, WallMarketFilter } from './market-client.js'
import type { ChartPayload } from './payload.js'
import type { FundamentalsPackage, Orderbook } from '@dsh-trading/market-data'

/** Timeframes the panel offers; filtered per provider by {@link timeframesForSource}. */
const TIMEFRAMES = PANEL_TIMEFRAMES

/** Bars per loadMore page. */
const HISTORY_PAGE_BARS = 500

const TF_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
}

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

/**
 * CoinGlass large walls refresh cadence. The capi endpoint is a private
 * third-party API whose data shifts every few tens of seconds, so polling at the
 * live-tape rate only adds requests; 20 s keeps the overlay current without that.
 */
const LARGE_WALLS_MS = 20_000

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
  if (raw === 'fetch failed' || raw.includes('fetch failed') || raw.includes('ECONNRESET') || raw.includes('ETIMEDOUT')) {
    return '行情服务连接超时或网络异常，请点击重新加载。'
  }
  return raw
}

function ChartErrorBanner({
  error,
  targetTimeframe,
  currentTimeframe,
  onRetry,
  onDismiss,
}: {
  error: string
  targetTimeframe?: string | undefined
  currentTimeframe?: string | undefined
  onRetry: () => void
  onDismiss: () => void
  onSwitchToCn?: () => void
  providerId?: string | undefined
}): JSX.Element {
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

/** Chinese compact USDT: 亿 / 万. Shared feel with market_snapshot / 爆仓文案. */
export function formatUsdtCn(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}万`
  if (abs < 0.5) return `${sign}0`
  return `${sign}${abs.toFixed(0)}`
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
function DerivativesStrip({ market, symbol, providerId, live, onData, hoveredTime, intervalMs }: {
  market: MarketClient
  symbol: string
  providerId: string
  live: boolean
  onData?: (data: PanelDerivatives | null) => void
  hoveredTime?: number | null
  /** Candle interval; >15m picks the last snapshot inside the bar. */
  intervalMs?: number | undefined
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

  const target = useMemo(() => derivativesForTime(data ?? undefined, hoveredTime, intervalMs), [data, hoveredTime, intervalMs])
  const hist = target !== undefined && 'isHistorical' in target && target.isHistorical === true

  if (providerId === 'cn' || data === null) return null
  if (failed !== null && data === undefined) {
    // Don't guess the cause: a timeout and "no such perpetual" both land here. Show the real error.
    return <div style={STRIP} title={failed}>合约数据获取失败（{failed.slice(0, 80)}），{DERIV_MS / 1000}s 后重试</div>
  }

  const show = (v: number | null | undefined, f: (n: number) => string): string =>
    v === null || v === undefined ? '—' : f(v)
  const countdown = target?.nextFundingTime ? formatCountdown(target.nextFundingTime, Date.now()) : ''
  const shownReadings = hist
    ? [
        ...(target?.readings ?? []),
        ...(data?.readings ?? []).filter(r => r.id === 'funding' || r.id === 'basis'),
      ]
    : (data?.readings ?? [])

  return (
    <div
      style={{ ...STRIP, opacity: failed !== null ? 0.5 : 1 }}
      title={failed !== null ? `刷新失败，显示的是旧数据：${failed}` : target ? `${target.source} USDT 永续 · ${new Date(target.time).toLocaleTimeString()}` : '加载中'}
    >
      {target ? <span>{target.source}</span> : null}
      {hist && target ? (
        <span style={{ background: 'rgba(255,167,38,0.2)', color: '#ffa726', padding: '0 4px', borderRadius: 3, fontWeight: 'bold' }}>
          历史 {new Date(target.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      ) : null}
      <span title="未平仓名义USDT=币数×标记价。跨所并列比，勿混口径。">OI名义<span style={VALUE}>{show(target?.openInterestValue, formatUsdtCn)}</span></span>
      <span title="未平仓币数；Δ%按币数算，避免价涨价跌伪装成平仓。">币数<span style={VALUE}>{show(target?.openInterest, n => compact.format(n))}</span></span>
      <span title="每8h结算。中性≈+0.01%/8h≈年化10.95%，不是看多。">
        {hist ? '当前费率' : '费率'}<span style={VALUE}>{show(target?.fundingRate, r => `${formatFunding(r)}/8h`)}</span>
        {data?.fundingRateAnnualizedPct != null ? <span style={{ marginLeft: 3, opacity: 0.85 }}>年化{data.fundingRateAnnualizedPct}%</span> : null}
        {data?.fundingLabel ? <span style={{ marginLeft: 3, opacity: 0.85 }}>{data.fundingLabel}</span> : null}
        {countdown !== '' ? <span style={{ marginLeft: 4 }}>{countdown}</span> : null}
      </span>
      {hist || target?.longShortRatio != null ? (
        <span title="本数据源指定合约的多头账户数÷空头账户数；>1仅表示多头账户更多，不能推断持仓量或价格方向。">账户人数比<span style={VALUE}>{show(target?.longShortRatio, n => n.toFixed(2))}</span></span>
      ) : null}
      {hist || target?.topPositionRatio != null ? (
        <span title="本数据源大户样本的多头持仓量÷空头持仓量；Binance样本为保证金余额前20%的用户。只代表样本内仓量，不代表全市场净仓或价格方向。">大户持仓比<span style={VALUE}>{show(target?.topPositionRatio, n => n.toFixed(2))}</span></span>
      ) : null}
      {hist || target?.topAccountRatio != null ? (
        <span title="本数据源大户样本的多头账户数÷空头账户数；按账户计数，不按仓量加权，不能直接推断资金去向。">大户账户比<span style={VALUE}>{show(target?.topAccountRatio, n => n.toFixed(2))}</span></span>
      ) : null}
      {hist || target?.takerBuySellRatio != null ? (
        <span title="主动买/卖量比（成交口径）">主动买卖<span style={VALUE}>{show(target?.takerBuySellRatio, n => n.toFixed(2))}</span></span>
      ) : null}
      {data?.cvd1h != null ? (
        <span title={`近1h主动买卖差（币数，非USDT）。${data.cvdNote ?? ''} 仅描述背离，非信号。`}>{hist ? '当前CVD1h' : 'CVD1h'}<span style={VALUE}>{compact.format(data.cvd1h)}</span>{data.cvdNote ? <span style={{ marginLeft: 3, opacity: 0.85 }}>{data.cvdNote}</span> : null}</span>
      ) : null}
      {data?.basisPct != null ? (
        <span title="标记相对指数；正=升水。">{hist ? '当前基差' : '基差'}<span style={VALUE}>{`${data.basisPct >= 0 ? '+' : ''}${data.basisPct.toFixed(3)}%`}</span></span>
      ) : null}
      {data?.liquidationSummary ? (
        <span title={data.liquidationSource && data.liquidationSource !== (data.source ?? '') ? `来源${data.liquidationSource}，与主所不同仅参考` : '近1h多/空爆仓名义'}>{hist ? '当前 ' : ''}{data.liquidationSummary}</span>
      ) : data && data.source && !data.liquidationSummary ? (
        <span style={{ opacity: 0.7 }} title="本所近1h爆仓暂无">爆仓 –</span>
      ) : null}
      {hist && (target?.quadrant || target?.posture) ? (
        <span title={target.quadrantNote ?? '该历史快照相对前一快照的价与持仓变化'}>当根 {target.quadrant ?? target.posture}</span>
      ) : null}
      {hist && !target?.quadrant && !target?.posture ? <span title="该K线无姿态数据">姿态 —</span> : null}
      {!hist && (target?.quadrant || target?.posture) ? (
        <span
          title={`价×仓姿态(按币数Δ)。1h价 ${target.priceChangePct1h != null ? (target.priceChangePct1h > 0 ? '+' : '') + target.priceChangePct1h.toFixed(2) + '%' : '—'} 仓 ${target.oiChangePct1h != null ? (target.oiChangePct1h > 0 ? '+' : '') + target.oiChangePct1h.toFixed(2) + '%' : '—'}；4h仓 ${data?.oiChangePct4h != null ? (data.oiChangePct4h > 0 ? '+' : '') + data.oiChangePct4h.toFixed(2) + '%' : '—'}；24h仓 ${data?.oiChangePct24h != null ? (data.oiChangePct24h > 0 ? '+' : '') + data.oiChangePct24h.toFixed(2) + '%' : '—'}。涨+增仓=新仓推动；涨+减仓=空头回补。${target.quadrantNote ?? target.posture ?? ''}`}
          style={{
            fontWeight: 600,
            padding: '0 4px',
            borderRadius: 3,
            background: postureColor(target.quadrant ?? target.posture).bg,
            color: postureColor(target.quadrant ?? target.posture).color,
          }}
        >
          {target.quadrant ?? target.posture}
          {target.quadrantNote ? (
            <span style={{ fontSize: 10, marginLeft: 3, opacity: 0.9 }}>{target.quadrantNote}</span>
          ) : null}
          {target.oiChangePct1h !== null && target.oiChangePct1h !== undefined ? (
            <span style={{ fontSize: 10, marginLeft: 3, opacity: 0.85 }}>
              (1h仓{target.oiChangePct1h > 0 ? '+' : ''}{target.oiChangePct1h.toFixed(1)}%{target.priceChangePct1h !== null && target.priceChangePct1h !== undefined ? ` 价${target.priceChangePct1h > 0 ? '+' : ''}${target.priceChangePct1h.toFixed(1)}%` : ''}{data?.oiChangePct4h != null ? ` ·4h仓${data.oiChangePct4h > 0 ? '+' : ''}${data.oiChangePct4h.toFixed(1)}%` : ''}{data?.oiChangePct24h != null ? ` ·24h仓${data.oiChangePct24h > 0 ? '+' : ''}${data.oiChangePct24h.toFixed(1)}%` : ''})
            </span>
          ) : null}
        </span>
      ) : null}
      {shownReadings.map(r => (
        <span
          key={r.id}
          title={(hist && (r.id === 'funding' || r.id === 'basis') ? '当前，不是这一根。' : '') + r.note}
          style={{
            fontSize: 10.5,
            padding: '1px 5px',
            borderRadius: 3,
            fontWeight: 500,
            background: r.tone === 'warn' ? 'rgba(255,167,38,0.15)' : 'rgba(128,128,128,0.12)',
            color: r.tone === 'warn' ? '#ffa726' : 'inherit',
          }}
        >
          {hist && (r.id === 'funding' || r.id === 'basis') ? '当前 ' : ''}{r.label}
        </span>
      ))}
      {target?.crowdVsWhale ? (
        <span
          title="账户人数比与大户持仓比背离"
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
 * Large order walls summary strip (CoinGlass capi).
 * Displays: 买墙/卖墙堵数、合计名义价值、最近强支撑/阻力价格、最近刷新时间与手动刷新按钮。
 */
function formatWallAge(startTime: number, currentTime?: number): string {
  const end = currentTime && currentTime > startTime ? currentTime : Date.now()
  const sec = Math.max(0, Math.floor((end - startTime) / 1000))
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${sec % 60}秒`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时${min % 60}分`
  const day = Math.floor(hr / 24)
  return `${day}天${hr % 24}小时`
}

function marketBadgeText(market?: string): string {
  if (!market) return ''
  return isSpotWallMarket(market) ? '现货' : '合约'
}

/** Short Chinese reason for a large-wall pull failure. */
function wallErrorText(error: string): string {
  if (/429/.test(error)) return 'CoinGlass 限流，稍后自动重试'
  if (/fetch failed|network|timeout|abort/i.test(error)) return '网络失败，稍后自动重试'
  return error.slice(0, 60)
}

function LargeWallsStrip({
  wallsData,
  currentPrice,
  marketFilter,
  onMarketFilter,
  onRefresh,
  error,
}: {
  wallsData: PanelLargeOrders | null
  currentPrice?: number | undefined
  marketFilter: WallMarketFilter
  onMarketFilter: (next: WallMarketFilter) => void
  onRefresh?: () => void
  /** Last pull failure; shown when there is nothing (or only stale data) on screen. */
  error?: string | null
}): JSX.Element | null {
  const [bookOpen, setBookOpen] = useState(false)
  const [sideFilter, setSideFilter] = useState<'all' | 'buy' | 'sell'>('all')

  if (!wallsData) {
    if (!error) return null
    return (
      <div style={{ ...STRIP, fontSize: 11, alignItems: 'center', color: '#d29922' }} title={error}>
        <span style={{ fontWeight: 600 }}>🧱 大单墙</span>
        <span>暂无数据：{wallErrorText(error)}</span>
        {onRefresh ? (
          <button type="button" onClick={onRefresh} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 11 }} title="立即重试">🔄</button>
        ) : null}
      </div>
    )
  }
  const walls = wallsData.walls ?? []

  const filteredWalls = filterWallsByMarket(walls, marketFilter)
  const staleAge = wallsData.updatedAt ? Math.max(0, Math.round((Date.now() - wallsData.updatedAt) / 1000)) : 0
  const staleNote = wallsData.stale || error
    ? `⚠ 延迟 ${staleAge >= 60 ? `${Math.round(staleAge / 60)}分` : `${staleAge}秒`}${error ? `（${wallErrorText(error)}）` : '（CoinGlass 限流）'}`
    : null

  const buys = filteredWalls
    .filter(w => w.side === 'buy')
    .sort((a, b) => b.price - a.price || b.currentUsd - a.currentUsd)
  const sells = filteredWalls
    .filter(w => w.side === 'sell')
    .sort((a, b) => a.price - b.price || b.currentUsd - a.currentUsd)

  const totalBuyUsd = buys.reduce((acc, w) => acc + w.currentUsd, 0)
  const totalSellUsd = sells.reduce((acc, w) => acc + w.currentUsd, 0)

  const fmtUsd = (n: number): string => {
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
    if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`
    return `${n.toFixed(0)}`
  }

  const updatedTime = wallsData.updatedAt
    ? new Date(wallsData.updatedAt).toLocaleTimeString()
    : '刚刚'

  const nearestBuy = buys[0]
  const nearestSell = sells[0]
  const maxUsd = Math.max(1, ...filteredWalls.map(w => w.currentUsd))
  const bookSells = sideFilter === 'buy' ? [] : [...sells].reverse()
  const bookBuys = sideFilter === 'sell' ? [] : buys

  const pillBtn = (active: boolean): CSSProperties => ({
    background: active ? 'rgba(83, 155, 245, 0.18)' : 'transparent',
    color: active ? '#539bf5' : 'var(--dsw-alias-text-2, #9ca3af)',
    border: `1px solid ${active ? 'rgba(83, 155, 245, 0.45)' : 'var(--dsw-alias-border-l2, rgba(128,128,128,0.25))'}`,
    borderRadius: 3,
    fontSize: 10,
    padding: '0 5px',
    cursor: 'pointer',
    lineHeight: '16px',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '0 0 auto' }}>
      <div
        style={{
          ...STRIP,
          background: 'var(--dsw-alias-bg-hover, rgba(128,128,128,0.06))',
          fontSize: 11,
          alignItems: 'center',
        }}
        title={`CoinGlass 大额挂单墙统计 (在挂订单) · 更新于 ${updatedTime}`}
      >
        <span style={{ fontWeight: 600, color: 'var(--dsw-alias-text-1, #ccc)' }}>
          🧱 大单墙
        </span>
        <span style={{ display: 'inline-flex', gap: 3 }}>
          {([['all', '全部'], ['perp', '合约'], ['spot', '现货']] as const).map(([k, label]) => (
            <button key={k} type="button" style={pillBtn(marketFilter === k)} onClick={() => onMarketFilter(k)}>
              {label}
            </button>
          ))}
        </span>
        <span style={{ color: '#3ddc97' }}>
          买墙: <span style={VALUE}>{buys.length}堵 ($${fmtUsd(totalBuyUsd)})</span>
          {nearestBuy ? (
            <span style={{ opacity: 0.9, marginLeft: 4 }}>
              [近撑 @{nearestBuy.price} {nearestBuy.exchange}{marketBadgeText(nearestBuy.market)}]
            </span>
          ) : null}
        </span>
        <span style={{ color: '#f47067' }}>
          卖墙: <span style={VALUE}>{sells.length}堵 ($${fmtUsd(totalSellUsd)})</span>
          {nearestSell ? (
            <span style={{ opacity: 0.9, marginLeft: 4 }}>
              [近阻 @{nearestSell.price} {nearestSell.exchange}{marketBadgeText(nearestSell.market)}]
            </span>
          ) : null}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={() => setBookOpen(v => !v)}
            style={{
              ...pillBtn(bookOpen),
              fontSize: 11,
              padding: '1px 6px',
              fontWeight: 600,
            }}
            title="展开/收起 CoinGlass 实时大额挂单簿明细"
          >
            📋 挂单簿 ({filteredWalls.length}) {bookOpen ? '▲' : '▼'}
          </button>
          <span style={{ opacity: 0.75 }}>更新: {updatedTime}</span>
          {staleNote ? <span style={{ color: '#d29922' }} title={error ?? 'CoinGlass 拒绝了本轮拉取，显示上一份成功数据'}>{staleNote}</span> : null}
          {wallsData.failedSources ? <span style={{ color: '#8b949e' }} title="部分交易所源本轮拉取失败，墙可能不全">缺{wallsData.failedSources}源</span> : null}
          {filteredWalls.length === 0 ? <span style={{ color: '#8b949e' }}>当前筛选无墙（门槛/距离/市场）</span> : null}
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'inherit',
                padding: '0 2px',
                fontSize: 11,
              }}
              title="立即刷新大单墙数据"
            >
              🔄
            </button>
          ) : null}
        </span>
      </div>

      {bookOpen ? (
        <div
          style={{
            borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18))',
            background: 'rgba(13, 17, 23, 0.75)',
            padding: '6px 10px',
            fontSize: 11,
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, color: '#8b949e' }}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <strong style={{ color: '#c9d1d9' }}>CoinGlass 挂单簿</strong>
              {([['all', '全部'], ['sell', '仅卖墙'], ['buy', '仅买墙']] as const).map(([k, label]) => (
                <button key={k} type="button" style={pillBtn(sideFilter === k)} onClick={() => setSideFilter(k)}>
                  {label}
                </button>
              ))}
            </span>
            <span style={{ fontSize: 10 }}>价格 · 交易所(市场) | 金额 | 距现价 | 挂单时长</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.1fr 0.7fr 0.9fr', gap: 4, alignItems: 'center', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {bookSells.map(w => {
              const dist = typeof currentPrice === 'number' && currentPrice > 0 ? ((w.price - currentPrice) / currentPrice) * 100 : null
              const pct = Math.min(100, Math.round((w.currentUsd / maxUsd) * 100))
              const mBadge = marketBadgeText(w.market)
              return (
                <div key={`s-${w.id}`} style={{ display: 'contents' }}>
                  <span style={{ color: '#f47067', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {w.price.toLocaleString('en-US', { maximumFractionDigits: 4 })}{' '}
                    <span style={{ color: '#c9d1d9', fontSize: 10 }}>{w.exchange}</span>
                    {mBadge ? <span style={{ marginLeft: 3, fontSize: 9, padding: '0 3px', borderRadius: 2, background: 'rgba(244,112,103,0.14)', color: '#f47067' }}>{mBadge}</span> : null}
                  </span>
                  <span style={{ position: 'relative', padding: '1px 4px', textAlign: 'right', color: '#c9d1d9' }}>
                    <span style={{ position: 'absolute', right: 0, top: 1, bottom: 1, width: `${pct}%`, background: 'rgba(244, 112, 103, 0.22)', borderRadius: 2, pointerEvents: 'none' }} />
                    <span style={{ position: 'relative' }}>${fmtUsd(w.currentUsd)}</span>
                  </span>
                  <span style={{ textAlign: 'right', color: '#f47067' }}>
                    {dist !== null ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%` : '—'}
                  </span>
                  <span style={{ textAlign: 'right', color: '#8b949e', fontSize: 10 }}>
                    {formatWallAge(w.startTime, w.currentTime)}
                  </span>
                </div>
              )
            })}
            {typeof currentPrice === 'number' && currentPrice > 0 ? (
              <div style={{ gridColumn: '1 / -1', padding: '3px 6px', margin: '2px 0', background: 'rgba(83, 155, 245, 0.12)', borderRadius: 3, display: 'flex', justifyContent: 'space-between', fontWeight: 600, color: '#58a6ff' }}>
                <span>现价 {wallsData.pair || wallsData.symbol}</span>
                <span>{currentPrice.toLocaleString('en-US', { maximumFractionDigits: 4 })}</span>
              </div>
            ) : null}
            {bookBuys.map(w => {
              const dist = typeof currentPrice === 'number' && currentPrice > 0 ? ((w.price - currentPrice) / currentPrice) * 100 : null
              const pct = Math.min(100, Math.round((w.currentUsd / maxUsd) * 100))
              const mBadge = marketBadgeText(w.market)
              return (
                <div key={`b-${w.id}`} style={{ display: 'contents' }}>
                  <span style={{ color: '#3ddc97', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {w.price.toLocaleString('en-US', { maximumFractionDigits: 4 })}{' '}
                    <span style={{ color: '#c9d1d9', fontSize: 10 }}>{w.exchange}</span>
                    {mBadge ? <span style={{ marginLeft: 3, fontSize: 9, padding: '0 3px', borderRadius: 2, background: 'rgba(61,220,151,0.14)', color: '#3ddc97' }}>{mBadge}</span> : null}
                  </span>
                  <span style={{ position: 'relative', padding: '1px 4px', textAlign: 'right', color: '#c9d1d9' }}>
                    <span style={{ position: 'absolute', right: 0, top: 1, bottom: 1, width: `${pct}%`, background: 'rgba(61, 220, 151, 0.22)', borderRadius: 2, pointerEvents: 'none' }} />
                    <span style={{ position: 'relative' }}>${fmtUsd(w.currentUsd)}</span>
                  </span>
                  <span style={{ textAlign: 'right', color: '#3ddc97' }}>
                    {dist !== null ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%` : '—'}
                  </span>
                  <span style={{ textAlign: 'right', color: '#8b949e', fontSize: 10 }}>
                    {formatWallAge(w.startTime, w.currentTime)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
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
  const [availableProviders, setAvailableProviders] = useState<{ id: string; description: string; timeframes?: string[] }[]>([
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
  const [panelLargeWalls, setPanelLargeWalls] = useState<PanelLargeOrders | null>(null)
  const [largeWallsError, setLargeWallsError] = useState<string | null>(null)
  const wallPriceRef = useRef<number | undefined>(undefined)
  const [largeWallsOn, setLargeWallsOn] = useState(() => peekSettings()['LARGE_WALLS']?.visible ?? false)
  const [wallMarket, setWallMarket] = useState<WallMarketFilter>('all')
  const [hoveredTime, setHoveredTime] = useState<number | null>(null)
  const followTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inflight = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const quiet = useRef(0)
  const fails = useRef(0)
  const failedFollow = useRef<string | null>(null)
  const ownOrigin = useRef<'user' | 'followed'>('user')
  const pullLargeWallsRef = useRef<(() => void) | null>(null)

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

  // 大单墙 toggle lives in 指标参数; mirror it here so we only poll when on.
  useEffect(() => subscribeSettings(() => {
    setLargeWallsOn(peekSettings()['LARGE_WALLS']?.visible ?? false)
  }), [])

  // Adopt whatever the agent last DREW, separately from what it last fetched.
  // Keyed on content, not identity: `latest` republishes the same payload
  // whenever an old card scrolls back into view, and an identical republish
  // must not disturb the chart or re-arm a dismissal.
  useEffect(() => {
    const next = readMarks(fromAgent)
    if (next === null) return
    const isCandidateZonePayload = fromAgent?.replaceMarks === true
    setMarks(cur => {
      const combined = combineMarks(cur, next, isCandidateZonePayload)
      if (cur !== null && cur.key === combined.key) return cur
      rememberMarks(combined)
      // A dismissal is about the marks that were on screen when it was
      // clicked, not a standing veto. Without this, adopting a different set
      // while an old key is dismissed hides the pill too — and with the pill
      // goes the only way back to the drawing.
      setDismissed(null)
      return combined
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

  // History paging (klinecharts loadMore): only on a series the panel fetched
  // itself. Older bars are merged into `own`, so payload candles == chart data
  // and per-bar indicator series stay index-aligned after the prepend.
  const ownSymbol = own?.symbol
  const ownTf = own?.timeframes[0]?.timeframe
  const ownProvider = own?.provider
  const history = useMemo<ChartHistory | undefined>(() => {
    if (ownSymbol === undefined || ownTf === undefined || market.getBefore === undefined) return undefined
    const pId = manualProvider === 'auto' ? ownProvider : manualProvider
    return {
      load: (beforeMs: number) => market.getBefore!(ownSymbol, ownTf, beforeMs, HISTORY_PAGE_BARS, pId),
      commit: (older) => setOwn(cur => {
        const tf0 = cur?.timeframes[0]
        if (cur == null || tf0 === undefined || cur.symbol !== ownSymbol || tf0.timeframe !== ownTf) return cur
        return withCandles(cur, mergeTail(tf0.candles, older))
      }),
    }
  }, [ownSymbol, ownTf, ownProvider, manualProvider, market])

  // Last close for the wall distance filter, read by the poller through a ref:
  // the live tail replaces payload.timeframes every second, and depending on it
  // restarted the poll (a 14-venue CoinGlass fan-out) each tick → HTTP 429 →
  // walls vanished. Price drift between 20 s polls does not matter.
  {
    const tf0 = payload?.timeframes?.[0]
    wallPriceRef.current = tf0?.candles?.[tf0.candles.length - 1]?.close
  }
  const wallSymbol = payload?.symbol

  // Poll CoinGlass large walls only while the overlay is enabled.
  useEffect(() => {
    if (!largeWallsOn || !wallSymbol || !market.getLargeOrders) {
      setPanelLargeWalls(null)
      setLargeWallsError(null)
      pullLargeWallsRef.current = null
      return
    }
    const symbol = wallSymbol
    // Another symbol's walls must never be drawn on this chart.
    setPanelLargeWalls(cur => (cur && cur.symbol === symbol ? cur : null))
    setLargeWallsError(null)
    let active = true
    let busy = false
    const controller = new AbortController()
    const pull = (manual = false): void => {
      if (busy) return
      if (!manual && typeof document !== 'undefined' && document.hidden) return
      busy = true
      const currentPrice = wallPriceRef.current
      const minWan = peekSettings()['LARGE_WALLS']?.params?.[0] ?? 100
      const maxDist = (peekSettings()['LARGE_WALLS']?.params?.[1] ?? 20) / 100
      const sideLimit = peekSettings()['LARGE_WALLS']?.params?.[2] ?? 12
      market.getLargeOrders!(
        symbol,
        {
          hours: 168,
          top: Math.max(40, sideLimit * 2),
          status: 'active',
          maxDistancePct: maxDist,
          minUsd: minWan * 10_000,
          ...(typeof currentPrice === 'number' ? { currentPrice } : {}),
        },
        controller.signal,
      ).then(
        snap => {
          busy = false
          if (!active) return
          setPanelLargeWalls(snap)
          setLargeWallsError(null)
        },
        (err: unknown) => {
          busy = false
          if (!active || controller.signal.aborted) return
          // Keep the last good walls on screen (marked stale) instead of
          // blanking strip + overlay on one refused poll.
          setLargeWallsError(err instanceof Error ? err.message : String(err))
          setPanelLargeWalls(cur => (cur && cur.symbol === symbol ? { ...cur, stale: true } : cur))
        },
      )
    }
    pullLargeWallsRef.current = () => pull(true)
    pull(true)
    const timer = setInterval(() => pull(), LARGE_WALLS_MS)
    // Hidden tabs skip polls; catch up as soon as the tab is shown again.
    const onVisible = (): void => { if (!document.hidden) pull() }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      controller.abort()
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      pullLargeWallsRef.current = null
    }
  }, [largeWallsOn, market, wallSymbol])


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
  const chartSource = manualProvider !== 'auto' ? manualProvider : (own?.provider ?? payload?.provider ?? 'auto')
  const visibleTimeframes = timeframesForSource(chartSource, availableProviders)
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
        {visibleTimeframes.map(tf => (
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
                intervalMs={shownTimeframe ? TF_MS[shownTimeframe] : undefined}
              />
            ) : null}
            {largeWallsOn && (panelLargeWalls || largeWallsError) ? (
              <LargeWallsStrip
                key="large-walls-strip"
                wallsData={panelLargeWalls}
                error={largeWallsError}
                currentPrice={payload.timeframes[0]?.candles[payload.timeframes[0].candles.length - 1]?.close}
                marketFilter={wallMarket}
                onMarketFilter={setWallMarket}
                onRefresh={() => pullLargeWallsRef.current?.()}
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
                </div>
                {hint !== null ? <p style={{ fontSize: 12, opacity: 0.75, marginTop: 10 }}>{hint}</p> : null}
              </div>
            )
            : payload !== null
              ? (
                <ChartErrorBoundary>
                  <ChartBody payload={payload} history={payload === own || payload === merged?.payload ? history : undefined} shell={PANEL_SHELL} fill prose={false} derivatives={panelDerivatives} largeWalls={panelLargeWalls} wallMarket={wallMarket} onCrosshairHover={setHoveredTime} />
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
