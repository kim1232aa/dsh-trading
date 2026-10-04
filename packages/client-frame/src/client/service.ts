/**
 * LayoutController: the `ctx.layout` face. Stock 0.2 plugins (ui-sidebar,
 * ui-workspace, ui-plugin-manager, ui-sidebar-right, ui-open-in-app) call
 * selectPanel / beginNavigation / panelInfo / toggleSidebar / openRightbar /
 * closeRightbar, so this must match the stock surface; chart actions are extra.
 */

type Actions = Record<string, (...args: any[]) => void>

/** Subscribable source of the central-panel selection (stock `panelInfo`). */
export interface PanelInfoSource {
  getSnapshot(): { activePanelId: string | null }
  subscribe(listener: () => void): () => void
}

export interface ILayout {
  readonly panelInfo: PanelInfoSource
  selectPanel(panelId: string | null): void
  beginNavigation(): AbortSignal
  toggleSidebar(): void
  openRightbar(track: boolean, fullscreen: boolean): void
  closeRightbar(): void
  openChart(): void
  closeChart(): void
  toggleChart(): void
}

export class LayoutController implements ILayout {
  #navigation = new AbortController()

  constructor(
    private readonly panels: Actions,
    private readonly hasMainPanel: (id: string) => boolean,
    readonly panelInfo: PanelInfoSource,
  ) {}

  selectPanel(panelId: string | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.#navigation.abort()
    this.panels.selectPanel!(panelId)
  }

  beginNavigation(): AbortSignal {
    this.#navigation.abort()
    this.#navigation = new AbortController()
    return this.#navigation.signal
  }

  dispose(): void {
    this.#navigation.abort()
  }

  toggleSidebar(): void { this.panels.toggleSidebar!() }
  openRightbar(track: boolean, fullscreen: boolean): void { this.panels.openRightbar!(track, fullscreen) }
  closeRightbar(): void { this.panels.closeRightbar!() }
  openChart(): void { this.panels.openChart!() }
  closeChart(): void { this.panels.closeChart!() }
  toggleChart(): void { this.panels.toggleChart!() }
}
