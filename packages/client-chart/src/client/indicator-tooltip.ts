import type { Chart, Indicator, IndicatorTooltipData } from 'klinecharts'

/** Subplots keep a readable legend even when the candle pane is folded. */
export const SUBPLOT_TOOLTIP = {
  showRule: 'always',
  showType: 'standard',
  showName: true,
  showParams: true,
  defaultValue: '—',
}

const hiddenTooltip = (): IndicatorTooltipData => ({ name: '', calcParamsText: '', values: [], icons: [] })

/** klinecharts gates every pane with one global showRule. Fold only candle-pane data. */
export function createMainPaneTooltipFold(chart: Pick<Chart, 'getIndicatorByPaneId' | 'overrideIndicator'>): (fold: boolean) => void {
  const originals = new Map<string, Indicator['createTooltipDataSource']>()
  return (fold) => {
    const indicators = chart.getIndicatorByPaneId('candle_pane')
    if (!(indicators instanceof Map)) return
    for (const [name, indicator] of indicators) {
      if (indicator instanceof Map) continue
      if (!originals.has(name)) originals.set(name, indicator.createTooltipDataSource)
      chart.overrideIndicator({
        name,
        createTooltipDataSource: fold ? hiddenTooltip : originals.get(name) ?? null,
      }, 'candle_pane')
    }
  }
}
