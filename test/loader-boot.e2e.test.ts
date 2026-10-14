// Keyless real-entry-path smoke (dsh docs/testing.md "Test the real entry path";
// docs/postmortem/0001-acp-default-export-drops-inject.md): boot a real `dsh web`
// process under a throwaway DSH_HOME, insert the built plugins through a
// test-only cordis patch, and read a probe's marker line. No API key, no
// network data: provider-csv points at a temp dir and nothing fetches quotes.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(__dirname, '..')
const pkg = (p: string) => join(root, 'packages', p, 'lib', 'index.js')
const hasDsh = spawnSync('dsh', ['--version']).status === 0
const built = ['market-data', 'provider-csv', 'provider-cn', 'tasks-schedule', 'authority'].every(p => existsSync(pkg(p)))

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const a = s.address(); s.close(() => typeof a === 'object' && a ? res(a.port) : rej(new Error('no port')))
    })
  })
}

let child: ChildProcess | undefined
let dir: string | undefined
afterEach(async () => {
  child?.kill('SIGTERM'); child = undefined
  if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined
})

async function boot(rows: string): Promise<{ tools: string[], providers: string[] | null }> {
  dir = await mkdtemp(join(tmpdir(), 'dsh-trading-boot-'))
  await mkdir(join(dir, 'home')); await mkdir(join(dir, 'ws')); await mkdir(join(dir, 'data'))
  const patch = join(dir, 'patch.yml')
  await writeFile(patch, `- insert:\n${rows.replaceAll('$DIR', dir)}    - id: probe\n      name: '${join(__dirname, 'fixtures', 'loader-probe.mjs')}'\n`)
  const port = await freePort()
  const env = { ...process.env, DSH_HOME: join(dir, 'home') }
  for (const k of Object.keys(env)) if (/API_KEY$/.test(k)) delete env[k]
  child = spawn('dsh', ['web', '--patch', patch, '--port', String(port), '--no-open'], { cwd: join(dir, 'ws'), env })
  return await new Promise((res, rej) => {
    let out = ''
    const timer = setTimeout(() => rej(new Error('no probe marker; output:\n' + out)), 80_000)
    const on = (b: Buffer) => {
      out += b
      const m = /DSH_TRADING_PROBE (\{.*\})/.exec(out)
      if (m) { clearTimeout(timer); res(JSON.parse(m[1]!)) }
    }
    child!.stdout!.on('data', on); child!.stderr!.on('data', on)
    child!.on('exit', code => { clearTimeout(timer); rej(new Error(`dsh exited ${code}:\n${out}`)) })
  })
}

describe.skipIf(!hasDsh || !built)('real dsh Loader boot (keyless)', () => {
  it('activates tasks-schedule, authority and providers from built packages', async () => {
    const r = await boot(`    - id: market-data
      name: '${pkg('market-data')}'
    - id: market-data-provider
      name: '${pkg('provider-csv')}'
      config: { root: '$DIR/data' }
    - id: provider-cn
      name: '${pkg('provider-cn')}'
    - id: tasks-schedule
      name: '${pkg('tasks-schedule')}'
      config: { tasksFilePath: '$DIR/ws/tasks.json', logsFilePath: '$DIR/ws/task-logs.json' }
    - id: authority
      name: '${pkg('authority')}'
      config: { grantPath: '$DIR/ws/grant.json' }
`)
    expect(r.tools.sort()).toEqual(['check_trade_authority', 'list_scheduled_tasks'])
    expect(r.providers).toEqual(expect.arrayContaining(['csv', 'cn']))
  }, 120_000)

  it('tasks-schedule still loads when no marketData service exists (optional dep)', async () => {
    const r = await boot(`    - id: tasks-schedule
      name: '${pkg('tasks-schedule')}'
      config: { tasksFilePath: '$DIR/ws/tasks.json', logsFilePath: '$DIR/ws/task-logs.json' }
`)
    expect(r.tools).toEqual(['list_scheduled_tasks'])
    expect(r.providers).toBeNull()
  }, 120_000)
})
