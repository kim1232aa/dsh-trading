/**
 * Atomic persistent file store for investment theses and research knowledge nodes.
 * @module @dsh-trading/knowledge
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { KnowledgeState, Thesis, ThesisFilter, ThesisStatus } from './types.js'

export interface KnowledgeStoreOptions {
  filePath: string
}

export class KnowledgeStore {
  readonly filePath: string

  constructor(options: KnowledgeStoreOptions) {
    this.filePath = options.filePath
  }

  /** Ensures store directory exists and file is initialized. */
  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      await readFile(this.filePath, 'utf-8')
    } catch {
      const defaultState: KnowledgeState = {
        theses: [],
      }
      await this.atomicWriteState(defaultState)
    }
  }

  private async atomicWriteState(state: KnowledgeState): Promise<void> {
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tempPath, this.filePath)
  }

  async readState(): Promise<KnowledgeState> {
    await this.init()
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const state = JSON.parse(raw) as KnowledgeState
      return {
        theses: Array.isArray(state.theses) ? state.theses : [],
      }
    } catch {
      return { theses: [] }
    }
  }

  /** Records a new research thesis or trading hypothesis. */
  async recordThesis(params: {
    symbol: string
    title: string
    thesis: string
    direction: 'bull' | 'bear' | 'neutral'
    timeframe: string
    entryTrigger?: string | undefined
    invalidationCondition: string
    targetPrice?: number | undefined
    tags?: string[] | undefined
  }): Promise<Thesis> {
    const state = await this.readState()
    const now = new Date().toISOString()
    const id = `th_${Date.now()}_${randomUUID().slice(0, 6)}`

    const newThesis: Thesis = {
      id,
      symbol: params.symbol.toUpperCase(),
      title: params.title,
      thesis: params.thesis,
      direction: params.direction,
      timeframe: params.timeframe,
      entryTrigger: params.entryTrigger,
      invalidationCondition: params.invalidationCondition,
      targetPrice: params.targetPrice,
      status: 'active',
      tags: params.tags && params.tags.length > 0 ? params.tags : ['general'],
      createdAt: now,
      updatedAt: now,
    }

    state.theses.unshift(newThesis)
    await this.atomicWriteState(state)
    return newThesis
  }

  /** Updates the status of an existing thesis (e.g. validated on profit target, invalidated on stop-loss). */
  async updateThesisStatus(
    id: string,
    status: ThesisStatus,
    invalidationReason?: string | undefined,
  ): Promise<Thesis | null> {
    const state = await this.readState()
    const item = state.theses.find(t => t.id === id)
    if (!item) return null

    item.status = status
    item.updatedAt = new Date().toISOString()
    if (invalidationReason) {
      item.invalidationReason = invalidationReason
    }

    await this.atomicWriteState(state)
    return item
  }

  /** Queries theses based on symbol, status, tag, or direction filters. */
  async queryTheses(filter?: ThesisFilter | undefined): Promise<Thesis[]> {
    const state = await this.readState()
    let results = state.theses

    if (!filter) return results

    if (filter.symbol) {
      const sym = filter.symbol.toUpperCase()
      results = results.filter(t => t.symbol === sym)
    }

    if (filter.status) {
      results = results.filter(t => t.status === filter.status)
    }

    if (filter.direction) {
      results = results.filter(t => t.direction === filter.direction)
    }

    if (filter.tag) {
      const tagLower = filter.tag.toLowerCase()
      results = results.filter(t => t.tags.some(tg => tg.toLowerCase() === tagLower))
    }

    return results
  }

  /** Gets a single thesis by its ID. */
  async getThesis(id: string): Promise<Thesis | null> {
    const state = await this.readState()
    return state.theses.find(t => t.id === id) ?? null
  }

  /** Aggregates tags with frequency counts (tagHubs pattern). */
  async listTags(): Promise<{ tag: string; count: number }[]> {
    const state = await this.readState()
    const counts = new Map<string, number>()
    for (const t of state.theses) {
      for (const tag of t.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  }
}
