/**
 * Contracts for research hypotheses, thesis tracking, and knowledge nodes.
 * @module @dsh-trading/knowledge
 */

export type ThesisDirection = 'bull' | 'bear' | 'neutral'

export type ThesisStatus = 'active' | 'validated' | 'invalidated' | 'closed'

export interface Thesis {
  id: string
  symbol: string
  title: string
  thesis: string
  direction: ThesisDirection
  timeframe: string
  entryTrigger?: string | undefined
  invalidationCondition: string
  targetPrice?: number | undefined
  status: ThesisStatus
  tags: string[]
  createdAt: string
  updatedAt: string
  invalidationReason?: string | undefined
}

export interface ThesisFilter {
  symbol?: string | undefined
  status?: ThesisStatus | undefined
  tag?: string | undefined
  direction?: ThesisDirection | undefined
}

export interface KnowledgeState {
  theses: Thesis[]
}
