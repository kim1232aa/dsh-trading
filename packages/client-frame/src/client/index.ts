/**
 * Browser half: the trading frame plugin — replaces stock ui-layout.
 *
 * Mirrors stock 0.2 ui-layout's apply(): provideRoot (panelInfo hook),
 * provide `layout` service, register TradingFrame into 'root' with the
 * 0.2 child slots + the extra 'trading.chart' seat, retain main panels.
 * Profile must disable the stock `ui-layout` row (one declarer per slot).
 */
import type {} from './slots.js'
import { LayoutController } from './service.js'
import { createLayoutStore } from './stores.js'
import { installFrameStyles } from './styles.js'
import { SessionSwitcher } from './SessionSwitcher.js'
import { ThemePresenter } from './theme-presenter.js'
import { TradingFrame } from './TradingFrame.js'

export { LayoutController } from './service.js'
export type { ILayout } from './service.js'
export type { ChartOwnerProps, SidebarOwnerProps } from './slots.js'

export const name = 'client-frame'

/** Same service gate as stock ui-layout (minus locale/shortcuts it doesn't use). */
export const inject = ['slots', 'theme']

// ponytail: ctx typed `any` — 0.2 ships no plugin-facing ClientContext
// augmentation for slots/theme/reflect. Tighten when upstream exports one.
export function apply(ctx: any): void {
  installFrameStyles()

  ctx.effect(() => {
    // One shared store instance: the frame renders it, the service drives it.
    const handle = createLayoutStore()
    const instance = handle.create()
    const store = { ...handle, create: () => instance }
    const actions = instance.actions as any

    const mainKeys = (): string[] =>
      ctx.slots.entries('main').flatMap((e: any) => (e.options.key === undefined ? [] : [e.options.key]))
    const retainMainPanels = () => actions.retainMainPanels(mainKeys())

    const layout = new LayoutController(
      actions,
      (id) => mainKeys().includes(id),
      {
        getSnapshot: () => instance.getSnapshot().panelInfo,
        subscribe: (listener) => instance.subscribe(listener),
      },
    )

    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register(
      {
        name: 'root',
        children: {
          'sidebar': { kind: 'single', scope: 'root' },
          'trading.chart': { kind: 'single', scope: 'session-maybe' },
          'main': { kind: 'keyed', scope: 'root' },
          'rightbar': { kind: 'single', scope: 'root' },
          'shell.overlay': { kind: 'list', scope: 'root' },
          'shell.leading': { kind: 'single', scope: 'root' },
        },
        store,
      },
      TradingFrame,
    )
    const disposePanels = ctx.slots.subscribe('main', retainMainPanels)
    retainMainPanels()

    return () => {
      layout.dispose()
      disposePanels()
      disposeRegistration()
      disposePanelInfo()
      disposeService()
    }
  }, 'client-frame: service + root registration')

  // Session switcher in the conversation header (sidebar starts collapsed).
  // uiWorkspace is optional: without it the switcher simply never mounts.
  ctx.inject(['uiWorkspace'], (sub: any) => {
    sub.slots.inject('conversation.session.header.utilities', () => [
      sub.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: 'trading-session-switcher',
          registrant: '@dsh-trading/client-frame',
          inject: () => ({ open: (id: string) => sub.uiWorkspace.openSession(id) }),
        },
        SessionSwitcher,
      ),
    ])
  })

  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot: any) => presenter.apply(snapshot))
    return () => {
      off()
      presenter.dispose()
    }
  }, 'client-frame: theme presenter')
}
