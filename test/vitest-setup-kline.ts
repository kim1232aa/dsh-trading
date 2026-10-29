/** klinecharts 10 reads window/navigator at module load; stub for node tests. */
const g = globalThis as Record<string, unknown>

function ensure(key: string, value: unknown): void {
  try {
    const desc = Object.getOwnPropertyDescriptor(g, key)
    if (!desc) {
      Object.defineProperty(g, key, { value, configurable: true, writable: true })
      return
    }
    if (desc.configurable && typeof desc.get === 'function' && !desc.set) {
      Object.defineProperty(g, key, { value, configurable: true, writable: true })
    }
  } catch {
    /* ignore */
  }
}

const nav = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  platform: 'Linux x86_64',
  maxTouchPoints: 0,
  language: 'en-US',
}

ensure('navigator', nav)

const doc = {
  createElement: (_tag?: string) => ({
    style: {} as Record<string, string>,
    getContext: () => ({
      measureText: () => ({ width: 0 }),
      fillText() {},
      strokeText() {},
      clearRect() {},
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fill() {},
      save() {},
      restore() {},
      scale() {},
      translate() {},
      setTransform() {},
      canvas: { width: 0, height: 0 },
    }),
    width: 0,
    height: 0,
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
  }),
  createElementNS: () => ({ style: {} }),
  body: { appendChild() {}, removeChild() {}, style: {} },
  documentElement: { style: {}, clientWidth: 800, clientHeight: 600 },
  getElementById: () => null,
  defaultView: g,
  addEventListener() {},
  removeEventListener() {},
}

ensure('document', doc)

const win = new Proxy(g, {
  get(target, prop, receiver) {
    if (prop === 'navigator') return nav
    if (prop === 'document') return doc
    if (prop === 'devicePixelRatio') return 1
    if (prop === 'innerWidth') return 800
    if (prop === 'innerHeight') return 600
    if (prop === 'requestAnimationFrame') return (cb: FrameRequestCallback) => setTimeout(cb, 16)
    if (prop === 'cancelAnimationFrame') return (id: number) => clearTimeout(id)
    if (prop === 'addEventListener') return () => {}
    if (prop === 'removeEventListener') return () => {}
    return Reflect.get(target, prop, receiver)
  },
})

ensure('window', win)
