/**
 * The root entry's transient layout store — 0.2 compatible.
 *
 * ponytail: merges the trading-frame column model (chart ratio, sidebar)
 * with 0.2's panelInfo + rightbar state so stock plugins that read
 * panelInfo / openRightbar / closeRightbar work. Drop the rightbar
 * passthrough when the frame gets a real right-panel UX.
 */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import {
  CHART_RATIO_DEFAULT,
  clampRatio,
  clampWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from './columns.js'

/** Rightbar drag clamp (matches stock ui-layout). */
const RIGHTBAR_MAX_RATIO = 0.45
const RIGHTBAR_DEFAULT_RATIO = 0.35

type LayoutState = {
  /** Active keyed panel in the 'main' slot. null = conversation. */
  panelInfo: { activePanelId: string | null }
  sidebar: number
  /** Chart share of the free width, 0 = closed. */
  chart: number
  narrow: boolean
  narrowExpanded: boolean
  /** Stock 0.2 viewport state for the rightbar solve. */
  viewportWidth: number
  rightbar: number | null
  rightbarShown: boolean
  rightbarTrack: boolean
  rightbarFullscreen: boolean
  rightbarInstant: boolean
}

export function createLayoutStore() {
  return defineStore({
    init: (): LayoutState => ({
      panelInfo: { activePanelId: null },
      sidebar: 0,
      chart: CHART_RATIO_DEFAULT,
      narrow: false,
      narrowExpanded: false,
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 1280,
      rightbar: null,
      rightbarShown: false,
      rightbarTrack: false,
      rightbarFullscreen: false,
      rightbarInstant: false,
    }),
    actions: {
      setSidebar: (d: LayoutState, px: number) => {
        d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX)
      },
      setChart: (d: LayoutState, ratio: number) => {
        d.chart = clampRatio(ratio)
      },
      openChart: (d: LayoutState) => {
        if (d.chart === 0) d.chart = CHART_RATIO_DEFAULT
      },
      closeChart: (d: LayoutState) => {
        d.chart = 0
      },
      toggleChart: (d: LayoutState) => {
        d.chart = d.chart === 0 ? CHART_RATIO_DEFAULT : 0
      },
      toggleSidebar: (d: LayoutState) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      setNarrow: (d: LayoutState, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      setViewportWidth: (d: LayoutState, width: number) => {
        if (d.viewportWidth === width) return
        d.rightbarInstant = false
        if (d.viewportWidth < 1024 !== width < 1024) d.narrowExpanded = false
        d.viewportWidth = width
      },
      // --- 0.2 stock panel selection (main slot keyed entry) ---
      selectPanel: (d: LayoutState, panelId: string | null) => {
        d.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (d: LayoutState, panelIds: string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId))
          d.panelInfo.activePanelId = null
      },
      // --- 0.2 stock rightbar state (for ui-sidebar-right) ---
      setRightbar: (d: LayoutState, px: number) => {
        d.rightbarInstant = false
        d.rightbar = clampWidth(px, 300, Math.max(300, d.viewportWidth * RIGHTBAR_MAX_RATIO))
      },
      openRightbar: (d: LayoutState, track: boolean, fullscreen: boolean) => {
        if (!d.rightbarShown || d.rightbarTrack !== track || d.rightbarFullscreen !== fullscreen)
          d.rightbarInstant = d.rightbarFullscreen && !fullscreen
        if (!d.rightbarShown && d.viewportWidth < 1024) d.narrowExpanded = false
        d.rightbar ??= Math.max(300, Math.round(d.viewportWidth * RIGHTBAR_DEFAULT_RATIO))
        d.rightbarShown = true
        d.rightbarTrack = track
        d.rightbarFullscreen = fullscreen
      },
      closeRightbar: (d: LayoutState) => {
        if (d.rightbarShown) d.rightbarInstant = d.rightbarFullscreen
        d.rightbarShown = false
        d.rightbarTrack = false
        d.rightbarFullscreen = false
      },
    },
  })
}
