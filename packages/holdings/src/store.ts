/**
 * Persistent store for two-zone portfolio ledger.
 * Staged candidate trades are stored in `staged/`, committed positions in `holdings.json`.
 * @module @dsh-trading/holdings
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyTradeToPosition,
  createEmptyPosition,
  inferAssetClassAndCurrency,
  summarizePortfolio,
  updatePositionMarketValue,
} from './ledger.js'
import type { HoldingPosition, PortfolioSummary, StagedTrade } from './types.js'

export interface StoreOptions {
  baseDir: string
}

export class HoldingsStore {
  readonly baseDir: string
  readonly stagedDir: string
  readonly committedDir: string
  readonly holdingsFile: string

  constructor(options: StoreOptions) {
    this.baseDir = options.baseDir
    this.stagedDir = join(this.baseDir, 'staged')
    this.committedDir = join(this.baseDir, 'committed')
    this.holdingsFile = join(this.baseDir, 'holdings.json')
  }

  /** Ensures store directory structure exists. */
  async init(): Promise<void> {
    await mkdir(this.stagedDir, { recursive: true })
    await mkdir(this.committedDir, { recursive: true })
    try {
      await readFile(this.holdingsFile, 'utf-8')
    } catch {
      await this.atomicWriteJson(this.holdingsFile, {})
    }
  }

  private async atomicWriteJson(filePath: string, data: unknown): Promise<void> {
    const tempPath = `${filePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8')
    await rename(tempPath, filePath)
  }

  /** Stages a candidate trade in the staging zone (uncommitted). */
  async stageTrade(
    params: Omit<StagedTrade, 'id' | 'stagedAt' | 'status'>,
  ): Promise<StagedTrade> {
    await this.init()
    const id = randomUUID()
    const trade: StagedTrade = {
      ...params,
      id,
      stagedAt: new Date().toISOString(),
      status: 'staged',
    }
    const tradePath = join(this.stagedDir, `${id}.json`)
    await this.atomicWriteJson(tradePath, trade)
    return trade
  }

  /** Lists all pending staged trades awaiting review/confirmation. */
  async listStagedTrades(): Promise<StagedTrade[]> {
    await this.init()
    const files = await readdir(this.stagedDir)
    const trades: StagedTrade[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.stagedDir, f), 'utf-8')
        trades.push(JSON.parse(raw) as StagedTrade)
      } catch {
        // ignore corrupted/temp files
      }
    }
    return trades.sort((a, b) => b.stagedAt.localeCompare(a.stagedAt))
  }

  /** Reads a specific staged trade by id. */
  async getStagedTrade(tradeId: string): Promise<StagedTrade | null> {
    await this.init()
    const tradePath = join(this.stagedDir, `${tradeId}.json`)
    try {
      const raw = await readFile(tradePath, 'utf-8')
      return JSON.parse(raw) as StagedTrade
    } catch {
      return null
    }
  }

  /** Commits a staged trade into the permanent ledger. */
  async commitTrade(tradeId: string): Promise<{
    trade: StagedTrade
    position: HoldingPosition
    realizedPnlDelta: number
  }> {
    await this.init()
    const stagedTrade = await this.getStagedTrade(tradeId)
    if (!stagedTrade) {
      throw new Error(`Staged trade '${tradeId}' not found.`)
    }
    if (stagedTrade.status !== 'staged') {
      throw new Error(`Trade '${tradeId}' is already ${stagedTrade.status}.`)
    }

    // Read current positions
    const holdingsMap = await this.getHoldingsMap()
    const symbolKey = stagedTrade.symbol.toUpperCase()
    let currentPos = holdingsMap[symbolKey]
    if (!currentPos) {
      const inferred = inferAssetClassAndCurrency(stagedTrade.symbol)
      currentPos = createEmptyPosition(stagedTrade.symbol, inferred.assetClass, stagedTrade.currency)
    }

    // Apply accounting math
    const { position: updatedPos, realizedPnlDelta } = applyTradeToPosition(currentPos, stagedTrade)
    holdingsMap[symbolKey] = updatedPos

    // Persist holdings atomically
    await this.atomicWriteJson(this.holdingsFile, holdingsMap)

    // Mark staged trade committed and move to committed/
    const committedTrade: StagedTrade = {
      ...stagedTrade,
      status: 'committed',
      committedAt: new Date().toISOString(),
    }
    const stagedPath = join(this.stagedDir, `${tradeId}.json`)
    const committedPath = join(this.committedDir, `${tradeId}.json`)
    await this.atomicWriteJson(committedPath, committedTrade)
    try {
      await unlink(stagedPath)
    } catch {
      // ignore unlink error
    }

    return {
      trade: committedTrade,
      position: updatedPos,
      realizedPnlDelta,
    }
  }

  /** Discards a staged trade without affecting positions. */
  async discardTrade(tradeId: string): Promise<StagedTrade> {
    await this.init()
    const stagedTrade = await this.getStagedTrade(tradeId)
    if (!stagedTrade) {
      throw new Error(`Staged trade '${tradeId}' not found.`)
    }
    const stagedPath = join(this.stagedDir, `${tradeId}.json`)
    try {
      await unlink(stagedPath)
    } catch {
      // ignore unlink error
    }
    return { ...stagedTrade, status: 'discarded' }
  }

  /** Reads all committed holding positions as a map. */
  async getHoldingsMap(): Promise<Record<string, HoldingPosition>> {
    await this.init()
    try {
      const raw = await readFile(this.holdingsFile, 'utf-8')
      return JSON.parse(raw) as Record<string, HoldingPosition>
    } catch {
      return {}
    }
  }

  /** Returns all active holding positions (quantity !== 0 or non-zero PnL). */
  async getPositions(): Promise<HoldingPosition[]> {
    const map = await this.getHoldingsMap()
    return Object.values(map).filter(p => Math.abs(p.quantity) > 0.00000001)
  }

  /** Refreshes positions with latest market prices. */
  async updateMarketPrices(priceMap: Record<string, number>): Promise<HoldingPosition[]> {
    const map = await this.getHoldingsMap()
    let changed = false

    for (const [sym, price] of Object.entries(priceMap)) {
      const key = sym.toUpperCase()
      if (map[key] && price > 0) {
        map[key] = updatePositionMarketValue(map[key]!, price)
        changed = true
      }
    }

    if (changed) {
      await this.atomicWriteJson(this.holdingsFile, map)
    }

    return Object.values(map)
  }

  /** Returns the full portfolio summary including staged trades count. */
  async getPortfolioSummary(): Promise<PortfolioSummary> {
    const positions = await this.getPositions()
    const stagedTrades = await this.listStagedTrades()
    return summarizePortfolio(positions, stagedTrades.length)
  }
}
