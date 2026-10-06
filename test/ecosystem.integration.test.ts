import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync } from 'node:crypto'

// Subsystem imports
import { parseTencentQuote } from '../packages/provider-cn/src/index.js'
import { screenUniverse, checkBullishAlignment } from '../packages/tool-market/src/screener.js'
import { runBacktest, createDualEmaStrategy } from '../packages/tool-market/src/backtest-engine.js'
import { validateFills } from '../packages/verdict/src/checks/fill-validation.js'
import { AuthorityEngine, signGrant } from '../packages/authority/src/verifier.js'
import type { TradingGrantPayload } from '../packages/authority/src/types.js'
import { HoldingsStore } from '../packages/holdings/src/store.js'
import { WatchlistStore } from '../packages/watchlist/src/store.js'
import { KnowledgeStore } from '../packages/knowledge/src/store.js'
import { TaskScheduler } from '../packages/tasks-schedule/src/scheduler.js'

describe('Ecosystem Full-Lifecycle Integration', () => {
  it('connects data -> screener -> backtest -> audit -> authority -> holdings -> knowledge -> watchlist -> schedule', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'dsh-trading-ecosystem-'))

    try {
      // 1. Data Layer: Tencent L2 Quote & Fundamentals parsing
      const rawTencentQuote = 'v_sh600519="1~贵州茅台~600519~1580.00~1575.00~1582.00~12345~100~200~1579.00~50~1578.00~30~1577.00~20~1576.00~10~1575.00~5~1581.00~40~1582.00~60~1583.00~80~1584.00~90~1585.00~100~~20261002150000~5.00~0.32~1585.00~1570.00~1580.00/12345/195000000~12345~19500~0.15~25.80~1585.00~1570.00~0.95~19800.50~19800.50~8.20~";'
      const quote = parseTencentQuote(rawTencentQuote, '600519')
      expect(quote).not.toBeNull()
      expect(quote!.orderbook.bids).toHaveLength(5)
      expect(quote!.orderbook.asks).toHaveLength(5)
      expect(quote!.fundamentals?.peTtm).toBe(25.80)
      expect(quote!.fundamentals?.pb).toBe(8.20)
      expect(quote!.fundamentals?.marketCap).toBe(19800.50 * 1e8)

      // 2. Screener: Screen universe based on technical structure
      const screenerBars: any[] = []
      let sPrice = 50
      const baseTime = Date.parse('2026-01-01T00:00:00.000Z')
      for (let i = 0; i < 220; i++) {
        sPrice += 1.0
        screenerBars.push({
          time: new Date(baseTime + i * 86400_000).toISOString(),
          open: sPrice - 0.5,
          high: sPrice + 1,
          low: sPrice - 1,
          close: sPrice,
          volume: 50000,
        })
      }

      const mockProvider: any = {
        getOhlcv: async ({ symbol }: any) => {
          if (symbol === '600519') return screenerBars
          return screenerBars.map(c => ({ ...c, close: 100, open: 100, high: 100, low: 100 }))
        },
      }
      const screened = await screenUniverse(mockProvider, ['600519', 'FLAT_COIN'], '1d', ['bullish_alignment'])
      expect(screened).toHaveLength(1)
      expect(screened[0]!.symbol).toBe('600519')

      // 3. Backtest Engine: Run Strategy over screened symbol with oscillating wave dataset
      const backtestBars: any[] = []
      let bPrice = 100
      for (let i = 0; i < 100; i++) {
        const change = Math.sin(i / 5) * 2 + 0.2
        const open = bPrice
        const close = bPrice + change
        const high = Math.max(open, close) + 1
        const low = Math.min(open, close) - 1
        const volume = 1000 + Math.abs(Math.sin(i)) * 500
        backtestBars.push({
          time: new Date(baseTime + i * 3600_000).toISOString(),
          open,
          high,
          low,
          close,
          volume,
        })
        bPrice = close
      }

      const backtestRes = runBacktest(
        '600519',
        '1h',
        backtestBars,
        createDualEmaStrategy(5, 15),
        { initialCapital: 100000, slippagePct: 0.0005, feePct: 0.0002 },
      )
      expect(backtestRes.totalTrades).toBeGreaterThanOrEqual(1)
      expect(backtestRes.sharpeRatio).toBeDefined()
      expect(backtestRes.artifact.trades.length).toBeGreaterThan(0)

      // 4. Verdict Audit: Audit backtest fills against true candle bars
      const fillAudit = validateFills(backtestRes.artifact.trades, backtestBars)
      expect(fillAudit.issues).toHaveLength(0)
      expect(fillAudit.tradesChecked).toBeGreaterThanOrEqual(1)
      expect(fillAudit.tradesOutsideData).toBe(0)

      // 5. Authority Plane: Ed25519 Cryptographic Grant & Invariants
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const grantPayload: TradingGrantPayload = {
        grantId: 'grant-prod-001',
        issuedAt: new Date(Date.now() - 60000).toISOString(),
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        allowedSymbols: ['600519', 'ETHUSDT'],
        maxPositionUSD: 500000,
        mode: 'live',
      }
      const grantPath = join(testDir, 'live-trading.grant.json')
      const grantFile = signGrant(grantPayload, privateKey)
      await writeFile(grantPath, JSON.stringify(grantFile, null, 2), 'utf-8')

      const authority = new AuthorityEngine({
        grantPath,
        publicKey,
      })
      const authDecision = await authority.checkAuthority({
        symbol: '600519',
        notionalUSD: 50000,
        mode: 'live',
      })
      expect(authDecision.allowed).toBe(true)
      expect(authDecision.mode).toBe('live')

      // 6. Holdings Subsystem: Two-zone portfolio staging and commit
      const holdingsStore = new HoldingsStore({ baseDir: join(testDir, 'holdings') })
      await holdingsStore.init()
      const stagedTrade = await holdingsStore.stageTrade({
        symbol: '600519',
        side: 'buy',
        quantity: 100,
        price: 1680,
        executedAt: new Date().toISOString(),
        notes: 'AI 突破策略信号入场',
      })
      expect(stagedTrade.status).toBe('staged')
      const committed = await holdingsStore.commitTrade(stagedTrade.id)
      expect(committed.trade.status).toBe('committed')
      const positions = await holdingsStore.getPositions()
      expect(positions).toHaveLength(1)
      expect(positions[0]!.symbol).toBe('600519')
      expect(positions[0]!.quantity).toBe(100)

      // 7. Knowledge Subsystem: Record research thesis with tagHubs
      const knowledgeStore = new KnowledgeStore({ filePath: join(testDir, 'knowledge.json') })
      await knowledgeStore.init()
      const thesis = await knowledgeStore.recordThesis({
        symbol: '600519',
        direction: 'bull',
        timeframe: '1d',
        title: '茅台估值均线共振突破',
        thesis: 'PE TTM 处于历史 30% 分位，且日线级别均线呈现标准多头排列。',
        invalidation: '跌破 1650 支撑位且放量则判定逻辑失效。',
        tags: ['白酒', '核心资产', '多头突破'],
      })
      expect(thesis.id).toBeDefined()
      const theses = await knowledgeStore.queryTheses({ symbol: '600519' })
      expect(theses).toHaveLength(1)
      const tags = await knowledgeStore.listTags()
      expect(tags.find(t => t.tag === '核心资产')).toBeDefined()

      // 8. Watchlist Subsystem: Add to categorized watchlist
      const watchlistStore = new WatchlistStore({ filePath: join(testDir, 'watchlist.json') })
      await watchlistStore.init()
      const watchItem = await watchlistStore.addItem({
        symbol: '600519',
        group: 'A股核心',
        notes: '已建仓，跟踪 1d 均线与白酒板块动量',
      })
      expect(watchItem.symbol).toBe('600519')
      const watchItems = await watchlistStore.listItems('A股核心')
      expect(watchItems.some(i => i.symbol === '600519')).toBe(true)

      // 9. Tasks Scheduler Subsystem: Create and trigger scheduled research task
      const taskScheduler = new TaskScheduler({
        tasksFilePath: join(testDir, 'tasks.json'),
        logsFilePath: join(testDir, 'logs.json'),
      })
      await taskScheduler.init()
      const task = await taskScheduler.createTask({
        name: '盘后茅台多头动量复盘',
        action: 'market_scan',
        intervalMinutes: 60,
        params: { symbol: '600519', rule: 'bullish_alignment' },
      })
      expect(task.id).toBeDefined()
      const execLog = await taskScheduler.recordExecution(
        task,
        'success',
        '均线多头排列良好，持仓正常',
        42,
      )
      expect(execLog.status).toBe('success')
      const logs = await taskScheduler.getLogs(task.id)
      expect(logs).toHaveLength(1)
    } finally {
      await rm(testDir, { recursive: true, force: true })
    }
  })
})
