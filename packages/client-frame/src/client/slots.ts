/**
 * Slot contract of the trading frame — 0.2 compatible.
 *
 * ponytail: 0.2 renamed conversation→main(keyed), details→rightbar,
 * added shell.leading. Slot names match stock ui-layout so every stock
 * plugin mounts unchanged. Drop the comment when targeting 0.2 only.
 */
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar': {
      kind: 'single'
      scope: 'root'
      owner: SidebarOwnerProps
    }
    /** Keyed panel slot. ui-conversation registers key "conversation". */
    'main': {
      kind: 'keyed'
      scope: 'root'
    }
    /** Right sidebar panel. ui-sidebar-right fills it. */
    'rightbar': {
      kind: 'single'
      scope: 'root'
    }
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
    }
    'shell.leading': {
      kind: 'single'
      scope: 'root'
    }
    /**
     * The persistent chart column — the one seat with no stock counterpart.
     */
    'trading.chart': {
      kind: 'single'
      scope: 'session-maybe'
      owner: ChartOwnerProps
    }
  }
}

/** Chart owner share: live column width from the frame's concession solve. */
export interface ChartOwnerProps {
  width: number
}

/** Sidebar owner share: column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  collapsed: boolean
  width: number
}

/** Keeps this a module under `isolatedModules`. */
export type FrameSlotChildren = ReactNode
