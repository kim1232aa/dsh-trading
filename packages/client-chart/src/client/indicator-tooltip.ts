import type { Chart, Indicator, IndicatorTooltipData } from 'klinecharts'
import { emptyTooltip } from './kline-v10.js'

/** Subplots keep a readable legend even when the candle pane is folded. */
export const SUBPLOT_TOOLTIP = {
  showRule: 'always' as const,
  showType: 'standard' as const,
  title: { showName: true, showParams: true },
  legend: { defaultValue: '—' },
}

const hiddenTooltip = (): IndicatorTooltipData => emptyTooltip()

/** klinecharts gates every pane with one global showRule. Fold only candle-pane data. */
/** `exempt`: indicators whose legend stays visible while folded (state legends like 波动带Pro). */
export function createMainPaneTooltipFold(
  chart: Pick<Chart, 'getIndicators' | 'overrideIndicator'>,
  exempt: ReadonlySet<string> = new Set(),
): (fold: boolean) => void {
  const originals = new Map<string, Indicator['createTooltipDataSource']>()
  return (fold) => {
    const indicators = chart.getIndicators({ paneId: 'candle_pane' })
    for (const indicator of indicators) {
      const name = indicator.name
      if (exempt.has(name)) continue
      if (!originals.has(name)) originals.set(name, indicator.createTooltipDataSource)
      chart.overrideIndicator({
        name,
        paneId: 'candle_pane',
        createTooltipDataSource: fold ? hiddenTooltip : originals.get(name) ?? null,
      })
    }
  }
}
