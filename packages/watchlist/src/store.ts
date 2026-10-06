/**
 * Atomic persistent file store for watchlist.
 * @module @dsh-trading/watchlist
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WatchlistItem, WatchlistState } from './types.js'

export const DEFAULT_GROUPS = ['自选', '加密货币', 'A股核心', '观察池']

export interface WatchlistStoreOptions {
  filePath: string
}

export class WatchlistStore {
  readonly filePath: string

  constructor(options: WatchlistStoreOptions) {
    this.filePath = options.filePath
  }

  /** Ensures store directory exists and file is initialized. */
  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      await readFile(this.filePath, 'utf-8')
    } catch {
      const defaultState: WatchlistState = {
        groups: [...DEFAULT_GROUPS],
        items: [
          { symbol: 'BTCUSDT', group: '加密货币', notes: '大饼基准', addedAt: new Date().toISOString() },
          { symbol: 'ETHUSDT', group: '加密货币', notes: '以太二饼', addedAt: new Date().toISOString() },
          { symbol: '600519', group: 'A股核心', notes: '贵州茅台', addedAt: new Date().toISOString() },
          { symbol: 'sh000001', group: 'A股核心', notes: '上证指数', addedAt: new Date().toISOString() },
        ],
      }
      await this.atomicWriteState(defaultState)
    }
  }

  private async atomicWriteState(state: WatchlistState): Promise<void> {
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tempPath, this.filePath)
  }

  async readState(): Promise<WatchlistState> {
    await this.init()
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const state = JSON.parse(raw) as WatchlistState
      return {
        groups: Array.isArray(state.groups) ? state.groups : [...DEFAULT_GROUPS],
        items: Array.isArray(state.items) ? state.items : [],
      }
    } catch {
      return { groups: [...DEFAULT_GROUPS], items: [] }
    }
  }

  /** Adds or updates a symbol in the watchlist. */
  async addItem(params: {
    symbol: string
    group?: string | undefined
    notes?: string | undefined
  }): Promise<WatchlistItem> {
    const state = await this.readState()
    const sym = params.symbol.toUpperCase()
    const grp = params.group?.trim() || '自选'

    if (!state.groups.includes(grp)) {
      state.groups.push(grp)
    }

    const existingIdx = state.items.findIndex(
      it => it.symbol.toUpperCase() === sym && it.group === grp,
    )

    const now = new Date().toISOString()
    const item: WatchlistItem = {
      symbol: sym,
      group: grp,
      notes: params.notes,
      addedAt: existingIdx >= 0 ? state.items[existingIdx]!.addedAt : now,
    }

    if (existingIdx >= 0) {
      state.items[existingIdx] = item
    } else {
      state.items.push(item)
    }

    await this.atomicWriteState(state)
    return item
  }

  /** Removes an item from the watchlist. If group is omitted, removes across all groups. */
  async removeItem(symbol: string, group?: string | undefined): Promise<boolean> {
    const state = await this.readState()
    const sym = symbol.toUpperCase()
    const prevCount = state.items.length

    if (group) {
      state.items = state.items.filter(
        it => !(it.symbol.toUpperCase() === sym && it.group === group),
      )
    } else {
      state.items = state.items.filter(it => it.symbol.toUpperCase() !== sym)
    }

    if (state.items.length !== prevCount) {
      await this.atomicWriteState(state)
      return true
    }
    return false
  }

  /** Lists items, optionally filtered by group. */
  async listItems(group?: string | undefined): Promise<WatchlistItem[]> {
    const state = await this.readState()
    if (!group) return state.items
    return state.items.filter(it => it.group === group)
  }

  /** Lists all configured groups. */
  async listGroups(): Promise<string[]> {
    const state = await this.readState()
    return state.groups
  }
}
