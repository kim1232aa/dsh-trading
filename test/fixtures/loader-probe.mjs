// Test-only probe loaded through the real dsh Loader by loader-boot.e2e.test.ts.
// Prints one marker line naming which dsh-trading tools/providers activated.
export const name = 'dsh-trading-loader-probe'
export const inject = ['tools']
export function apply(ctx) {
  ctx.effect(() => {
    const t = setTimeout(() => {
      const tools = ['list_scheduled_tasks', 'check_trade_authority'].filter(n => ctx.tools.get(n))
      const md = ctx.get('marketData')
      const providers = md?.ids?.() ?? md?.list?.() ?? null
      console.log('DSH_TRADING_PROBE ' + JSON.stringify({ tools, providers }))
    }, 1500)
    return () => clearTimeout(t)
  })
}
