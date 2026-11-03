/**
 * Whether the chart column should follow the conversation, as a pure decision.
 *
 * The rule lives here rather than inside the panel's effect so it can be
 * tested: this package's suite is plain vitest with no DOM, and a policy
 * buried in a `useEffect` is a policy nobody can pin. The effect keeps the
 * timers and the fetch; this decides.
 * @module
 */

/** What the conversation is currently looking at. */
export interface FollowTarget {
  symbol: string
  timeframe: string | undefined
  /** Whether this card carries annotations/scenarios of its own. */
  hasMarks?: boolean | undefined
}

/** What the panel already holds. */
export interface FollowState {
  /** Rendered column width; 0 means the frame closed the column. */
  width: number
  /** The user took the wheel — the column stops chasing the conversation. */
  pinned: boolean
  /** The series the panel fetched for itself, if any. */
  own: { symbol: string; timeframe: string | undefined } | null
  /** Active drawings remembered/adopted by the panel, if any. */
  marks?: { symbol: string; timeframe: string } | null | undefined
}

/** The panel's next move. */
export type FollowDecision =
  | { action: 'load'; symbol: string; timeframe: string }
  /** Nothing to follow, or the column is closed. */
  | { action: 'none' }
  /** The user is driving; the offer belongs on the pill instead. */
  | { action: 'hold' }
  /** This exact series is already on screen and live. */
  | { action: 'already' }

/** Case- and space-insensitive instrument identity. */
function sameSymbol(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase()
}

/**
 * Decide whether to pull the conversation's chart into the column.
 *
 * The order matters. A closed column has nowhere to draw, so it never fetches.
 * A pinned column belongs to the user, so an agent chart becomes an offer on
 * the pill rather than a takeover. And a column already showing that series
 * must NOT reload it: the agent re-charts the same instrument many times in
 * one analysis, and refetching each time would throw away the live series —
 * along with its scroll position — for bars it already has.
 *
 * @param target - the instrument and interval the conversation is on.
 * @param state - what the column currently holds.
 * @returns the move, for the caller to schedule.
 */
export function decideFollow(target: FollowTarget | null, state: FollowState): FollowDecision {
  if (state.width === 0) return { action: 'none' }
  const markedSym = state.marks?.symbol?.trim() ?? ''
  const markedTf = state.marks?.timeframe
  if (target === null) {
    if (!state.pinned && state.own === null && markedSym !== '' && markedTf !== undefined && markedTf !== '') {
      return { action: 'load', symbol: markedSym, timeframe: markedTf }
    }
    return { action: 'none' }
  }

  const symbol = target.symbol.trim()
  const timeframe = target.timeframe
  if (symbol === '' || timeframe === undefined) return { action: 'none' }

  // A drawing-less card on another symbol (e.g. a side get_ohlcv(BTCUSDT) check
  // or an old root card remounting on session switch) must not yank the panel
  // away from the instrument that owns the active drawings.
  if (markedSym !== '' && !sameSymbol(symbol, markedSym) && target.hasMarks === false) {
    if (!state.pinned && state.own === null && markedTf !== undefined && markedTf !== '') {
      return { action: 'load', symbol: markedSym, timeframe: markedTf }
    }
    return { action: 'hold' }
  }

  if (state.own !== null
    && sameSymbol(state.own.symbol, symbol)
    && state.own.timeframe === timeframe) return { action: 'already' }

  // Pinned is checked AFTER 'already' on purpose: a pinned column that happens
  // to be on the very series the agent charted is not holding anything back,
  // and reporting a hold there would light up an offer for a chart the user is
  // already looking at.
  if (state.pinned) return { action: 'hold' }

  return { action: 'load', symbol, timeframe }
}
