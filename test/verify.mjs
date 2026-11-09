/**
 * dsh-app-launcher — 回归测试（`node test/verify.mjs`）。
 *
 * 用假依赖与临时目录，不碰真实 GPU、端口或用户配置。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveConfig,
  findProgram,
  normalizeProgram,
  normalizeAllowedDirs,
  isAbsolutePath,
  isPathAllowed,
  effectiveAllowedDirs,
} from '../lib/config.mjs'
import {
  evaluateResourceGate,
  evaluateConflict,
  decideStart,
  formatMiB,
  normalizeNeeds,
} from '../lib/gate.mjs'
import {
  parseGpuCsv,
  parseGpuName,
  parseGpuProcesses,
  parseCpuLoad,
  cpuLoadFromTimes,
  createSampler,
} from '../lib/sysinfo.mjs'
import {
  parseNetstatListeners,
  parseLsofListeners,
  portOf,
  buildCommand,
  describeCommand,
  processNameOf,
  probeReady,
  listeningPids,
  createRegistry,
  ensureRunning,
} from '../lib/programs.mjs'
import { LauncherRuntime } from '../lib/runtime.mjs'
import { registerLauncherTools } from '../lib/tools.mjs'
import { verifyAll, verifyProgram } from '../lib/verify.mjs'
import { isSameOrigin } from '../lib/http.mjs'
import {
  addProgram,
  updateProgram,
  removeProgram,
  updateGlobal,
  validateProgram,
  validateProgramPaths,
  deriveId,
  splitArgs,
  parseEnvText,
} from '../lib/edit.mjs'
import { createConfigStore } from '../lib/store.mjs'
import { listAllowedDirectory, assertLaunchPathAllowed, parentOf } from '../lib/browse.mjs'

/** 测试用路径探针：假装任何路径都存在（真实校验另有专门用例）。 */
const ALWAYS_EXISTS = () => ({ exists: true, isDirectory: false })

let passed = 0
const failures = []

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`  ok  ${name}`)
    })
    .catch((error) => {
      failures.push({ name, error })
      console.log(`  FAIL ${name}`)
      console.log(`       ${error?.message ?? error}`)
    })
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

const tmpDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-app-launcher-test-'))
  tmpDirs.push(dir)
  return dir
}

// ---------- sysinfo ----------

section('sysinfo')

await test('parseGpuCsv 解析利用率与显存', () => {
  const gpu = parseGpuCsv('20, 3306, 16303\n')
  assert.equal(gpu.utilPct, 20)
  assert.equal(gpu.freeMiB, 16303 - 3306)
})

await test('parseGpuCsv 坏数据返回 null', () => {
  assert.equal(parseGpuCsv(''), null)
  assert.equal(parseGpuCsv('abc, def, ghi'), null)
})

await test('parseGpuName 跳过标题行', () => {
  assert.equal(parseGpuName('name\nNVIDIA GeForce RTX 5080\n'), 'NVIDIA GeForce RTX 5080')
})

await test('parseGpuProcesses 丢弃显存读不到的进程', () => {
  const text = [
    'pid, process_name, used_gpu_memory [MiB]',
    '11032, C:\\Windows\\explorer.exe, [N/A]',
    '29124, C:\\llama-server.exe, 5120',
  ].join('\n')
  const procs = parseGpuProcesses(text)
  assert.equal(procs.length, 1)
  assert.equal(procs[0].pid, 29124)
})

await test('parseCpuLoad 解析 wmic 输出', () => {
  assert.equal(parseCpuLoad('LoadPercentage=42'), 42)
  assert.equal(parseCpuLoad('no data'), null)
})

await test('cpuLoadFromTimes 用两次采样差值', () => {
  assert.equal(cpuLoadFromTimes({ idle: 100, total: 200 }, { idle: 200, total: 400 }), 50)
  assert.equal(cpuLoadFromTimes({ idle: 100, total: 200 }, { idle: 100, total: 200 }), null)
})

await test('createSampler 缓存生效且可失效', async () => {
  let calls = 0
  const sampler = createSampler({
    cacheMs: 5000,
    deps: {
      queryGpu: async () => { calls += 1; return { utilPct: 5, usedMiB: 100, totalMiB: 16303, freeMiB: 16203 } },
      queryGpuName: async () => 'Fake GPU',
      queryGpuProcesses: async () => [],
      queryCpuLoad: async () => 10,
    },
  }, () => {})
  const first = await sampler.sample()
  assert.equal(first, await sampler.sample())
  assert.equal(calls, 1)
  sampler.invalidate()
  await sampler.sample()
  assert.equal(calls, 2)
})

// ---------- gate ----------

section('gate 门控')

const idleSample = {
  gpu: { utilPct: 3, usedMiB: 800, totalMiB: 16303, freeMiB: 15503 },
  gpuProcesses: [],
  cpu: { pct: 8, cpus: 24 },
  memory: { totalMiB: 32768, freeMiB: 20480, usedMiB: 12288 },
}

const busySample = {
  ...idleSample,
  gpu: { utilPct: 92, usedMiB: 14000, totalMiB: 16303, freeMiB: 2303 },
  gpuProcesses: [{ pid: 999, name: 'blender.exe', usedMiB: 12345 }],
}

await test('idle 机器上所有阈值通过', () => {
  const gate = evaluateResourceGate(idleSample, { gpuUtilPctMax: 10, freeVramMiBMin: 6000, freeRamMiBMin: 8192, cpuPctMax: 80 })
  assert.equal(gate.ok, true)
})

await test('GPU 忙时拒绝并给出读数', () => {
  const gate = evaluateResourceGate(busySample, { gpuUtilPctMax: 10 })
  assert.equal(gate.ok, false)
  assert.match(gate.failed[0].message, /92%/)
})

await test('显存不足时拒绝', () => {
  const gate = evaluateResourceGate(busySample, { freeVramMiBMin: 12000 })
  assert.equal(gate.ok, false)
  assert.equal(gate.failed[0].name, 'free-vram')
})

await test('CPU 超阈值拒绝', () => {
  assert.equal(evaluateResourceGate({ ...idleSample, cpu: { pct: 95, cpus: 8 } }, { cpuPctMax: 80 }).ok, false)
})

await test('读不到 GPU：拒绝 / allow 放行', () => {
  const sample = { ...idleSample, gpu: null }
  assert.equal(evaluateResourceGate(sample, { freeVramMiBMin: 6000 }, { unreadableGpuPolicy: 'reject' }).ok, false)
  assert.equal(evaluateResourceGate(sample, { freeVramMiBMin: 6000 }, { unreadableGpuPolicy: 'allow' }).ok, true)
})

await test('未配置阈值不参与判定', () => {
  assert.equal(evaluateResourceGate(busySample, {}).ok, true)
})

await test('formatMiB 人类可读', () => {
  assert.equal(formatMiB(512), '512 MiB')
  assert.equal(formatMiB(8192), '8.0 GiB')
  assert.equal(formatMiB(null), '未知')
})

await test('normalizeNeeds 空串归一成 null', () => {
  const needs = normalizeNeeds({ gpuUtilPctMax: '', cpuPctMax: '60' })
  assert.equal(needs.gpuUtilPctMax, null)
  assert.equal(needs.cpuPctMax, 60)
})

section('gate 同族互斥')

const runningComfy = [{ id: 'comfyui', name: 'ComfyUI', exclusive: 'gpu-heavy', running: true, canStop: true }]

await test('同组已在跑 → 拒绝并给建议', () => {
  const res = evaluateConflict('lm-studio', 'gpu-heavy', runningComfy, 'reject')
  assert.equal(res.ok, false)
  assert.ok(res.suggestions.length >= 2)
})

await test('stop-own 放行并给出 stopFirst', () => {
  const res = evaluateConflict('lm-studio', 'gpu-heavy', runningComfy, 'stop-own')
  assert.equal(res.ok, true)
  assert.deepEqual(res.stopFirst, ['comfyui'])
})

await test('stop-own 但冲突者非本插件启动 → 拒绝', () => {
  const foreign = [{ id: 'comfyui', name: 'ComfyUI', exclusive: 'gpu-heavy', running: true, canStop: false }]
  assert.equal(evaluateConflict('lm-studio', 'gpu-heavy', foreign, 'stop-own').ok, false)
})

await test('不同组 / 空组不互斥', () => {
  assert.equal(evaluateConflict('lm-studio', 'other', runningComfy).ok, true)
  assert.equal(evaluateConflict('lm-studio', '', runningComfy).ok, true)
})

section('gate 综合判定')

const comfy = normalizeProgram({
  id: 'comfyui', name: 'ComfyUI', exclusive: 'gpu-heavy',
  launch: { exe: 'C:/fake/ComfyUI.exe' },
  needs: { gpuUtilPctMax: 10, freeVramMiBMin: 6000 },
})

await test('已在线 → already-running', () => {
  assert.equal(decideStart({ target: comfy, sample: idleSample, online: true }).action, 'already-running')
})

await test('空闲无冲突 → start', () => {
  assert.equal(decideStart({ target: comfy, sample: idleSample }).action, 'start')
})

await test('忙 → reject，理由带读数与占用进程', () => {
  const res = decideStart({ target: comfy, sample: busySample })
  assert.equal(res.action, 'reject')
  assert.match(res.reason, /92%/)
  assert.ok(res.suggestions.some((s) => s.includes('blender.exe')))
})

// ---------- config ----------

section('config 归一化')

await test('缺 exe 的程序标记 invalid 而非丢弃', () => {
  const cfg = resolveConfig({ programs: [{ id: 'x', name: 'X' }] })
  assert.equal(cfg.programs.length, 1)
  assert.equal(cfg.programs[0].valid, false)
})

await test('补齐默认值', () => {
  const cfg = resolveConfig({ programs: [{ id: 'a', launch: { exe: 'C:/a.exe' } }] })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.conflictPolicy, 'reject')
  assert.equal(cfg.programs[0].ready.timeoutMs, 180000)
})

await test('非法策略归一到安全默认', () => {
  const cfg = resolveConfig({ conflictPolicy: 'kill-anything', unreadableGpuPolicy: 'whatever' })
  assert.equal(cfg.conflictPolicy, 'reject')
  assert.equal(cfg.unreadableGpuPolicy, 'reject')
})

await test('findProgram 按 id 与 name 匹配', () => {
  const cfg = resolveConfig({ programs: [{ id: 'ComfyUI', name: 'ComfyUI 桌面版', launch: { exe: 'C:/c.exe' } }] })
  assert.ok(findProgram(cfg.programs, 'comfyui'))
  assert.ok(findProgram(cfg.programs, 'comfyui 桌面版'))
  assert.equal(findProgram(cfg.programs, 'not-there'), null)
})

await test('args 与 env 强制成字符串', () => {
  const program = normalizeProgram({ id: 'a', launch: { exe: 'C:/a.exe', args: [1, 2], env: { A: 1 } } })
  assert.deepEqual(program.launch.args, ['1', '2'])
  assert.deepEqual(program.launch.env, { A: '1' })
})

await test('程序级 allowedDirs 被归一化', () => {
  const program = normalizeProgram({ id: 'a', launch: { exe: 'C:/a.exe' }, allowedDirs: ['C:\\A\\', 'c:/a'] })
  assert.deepEqual(program.allowedDirs, ['C:\\A'])
})

await test('cwd 未填时推导为 exe 目录并标记非显式', () => {
  const program = normalizeProgram({ id: 'a', launch: { exe: 'C:\\Apps\\a.exe' } })
  assert.equal(program.launch.cwd, 'C:\\Apps')
  assert.equal(program.launch.cwdExplicit, false)
})

await test('cwd 显式填写时标记为显式', () => {
  const program = normalizeProgram({ id: 'a', launch: { exe: 'C:\\Apps\\a.exe', cwd: 'C:\\Work' } })
  assert.equal(program.launch.cwdExplicit, true)
})

// ---------- programs ----------

section('programs 命令行/端口')

await test('buildCommand 优先用 commandOverride', () => {
  const cmd = buildCommand({ launch: { exe: 'C:/a.exe', args: ['x'], commandOverride: ['C:/b.exe', 'y'] } })
  assert.equal(cmd.exe, 'C:/b.exe')
  assert.deepEqual(cmd.argv, ['y'])
})

await test('describeCommand 给含空格路径加引号', () => {
  const text = describeCommand({ launch: { exe: 'C:\\Program Files\\x.exe', args: ['--port', '1'], cwd: '' } })
  assert.ok(text.startsWith('"C:\\Program Files\\x.exe"'))
})

await test('portOf 从 ready.url 取端口', () => {
  assert.equal(portOf({ ready: { url: 'http://127.0.0.1:8188/system_stats' } }), 8188)
  assert.equal(portOf({ ready: { url: '' } }), null)
})

await test('processNameOf 从 exe 取进程名', () => {
  assert.equal(processNameOf('E:\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe'), 'blender')
  assert.equal(processNameOf(''), '')
})

await test('probeReady 无 url 时交给进程名判定', async () => {
  const result = await probeReady({ ready: { url: '' } }, () => {})
  assert.equal(result.byProcess, true)
  assert.equal(result.ready, null)
})

await test('listeningPids 对无端口程序按进程名探测', async () => {
  const seen = []
  const pids = await listeningPids(
    { launch: { exe: 'E:\\B\\blender.exe' }, ready: { url: '' } },
    () => {},
    { pidsByProcessName: (name) => { seen.push(name); return [4242] } },
  )
  assert.deepEqual(seen, ['blender'])
  assert.deepEqual(pids, [4242])
})

await test('parseNetstatListeners 只取 LISTENING', () => {
  const text = [
    '  TCP    127.0.0.1:8188         0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:8188         127.0.0.1:50000        ESTABLISHED     4242',
  ].join('\r\n')
  assert.deepEqual(parseNetstatListeners(text, 8188), [4242])
})

await test('parseLsofListeners 去重', () => {
  assert.deepEqual(parseLsofListeners('101\n202\n101\n'), [101, 202])
})

// ---------- runtime ----------

section('runtime 端到端')

function makeFakeEnv({ gpu, portPids = [], onlineIds = null } = {}) {
  const killed = []
  const isOnline = (program) => Array.isArray(onlineIds) && onlineIds.includes(program?.id)
  const deps = {
    sysinfo: {
      queryGpu: async () => gpu ?? { utilPct: 3, usedMiB: 500, totalMiB: 16303, freeMiB: 15803 },
      queryGpuName: async () => 'Fake RTX',
      queryGpuProcesses: async () => [],
      queryCpuLoad: async () => 6,
    },
    status: {
      probeReady: async (program) => {
        const hasUrl = Boolean(program?.ready?.url)
        const on = isOnline(program)
        return hasUrl
          ? { ready: on, byProcess: false, status: on ? 200 : null }
          : { ready: null, byProcess: true, status: null }
      },
      listeningPids: async () => portPids,
    },
    programs: {
      listeningPids: async () => portPids,
      killProcessTree: async (pid) => { killed.push(pid); return { ok: true } },
      processExePath: async () => null,
    },
    edit: { probe: ALWAYS_EXISTS },
  }
  return { deps, killed }
}

const makeRuntime = (seed, deps, dir) => new LauncherRuntime({ seed, deps, dataDir: dir })

await test('dryRun 受理但不起进程', async () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({
    dryRun: true, sampleCacheMs: 0,
    programs: [{
      id: 'comfyui', name: 'ComfyUI',
      launch: { exe: process.execPath, args: ['-e', ''], cwd: dir },
      needs: { gpuUtilPctMax: 10 },
      ready: { url: 'http://127.0.0.1:8188/x', timeoutMs: 3000, intervalMs: 200 },
    }],
  }, deps, dir)
  const res = await runtime.requestStart('comfyui')
  assert.equal(res.accepted, true)
  const waited = await runtime.waitStart('comfyui', 3000)
  assert.equal(waited.ok, true)
  assert.equal(waited.result.dryRun, true)
})

await test('门控拒绝时不受理并返回读数', async () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv({ gpu: { utilPct: 95, usedMiB: 15000, totalMiB: 16303, freeMiB: 1303 } })
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{
      id: 'comfyui', launch: { exe: process.execPath, args: ['-e', ''] },
      needs: { gpuUtilPctMax: 10, freeVramMiBMin: 6000 },
      ready: { url: 'http://127.0.0.1:8188/x' },
    }],
  }, deps, dir)
  const res = await runtime.requestStart('comfyui')
  assert.equal(res.accepted, false)
  assert.match(res.reason, /95%/)
  assert.ok(res.suggestions.length > 0)
})

await test('未知 id 报错', async () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({ sampleCacheMs: 0, programs: [{ id: 'a', launch: { exe: 'C:/a.exe' } }] }, deps, dir)
  await assert.rejects(() => runtime.requestStart('nope'), /未知程序/)
})

await test('enabled=false 的程序拒绝启动', async () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({ sampleCacheMs: 0, programs: [{ id: 'a', enabled: false, launch: { exe: 'C:/a.exe' } }] }, deps, dir)
  await assert.rejects(() => runtime.requestStart('a'), /禁用/)
})

await test('插件级 enabled=false 拒绝起停', async () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({ enabled: false, sampleCacheMs: 0, programs: [{ id: 'a', launch: { exe: 'C:/a.exe' } }] }, deps, dir)
  await assert.rejects(() => runtime.requestStart('a'), /插件已全局禁用/)
  await assert.rejects(() => runtime.requestStop('a'), /插件已全局禁用/)
})

await test('同族互斥拒绝第二个', async () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv({ portPids: [4242], onlineIds: ['comfyui'] })
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [
      { id: 'comfyui', name: 'ComfyUI', exclusive: 'gpu-heavy', launch: { exe: 'C:/c.exe' }, ready: { url: 'http://127.0.0.1:8188/x' } },
      { id: 'lm', name: 'LM Studio', exclusive: 'gpu-heavy', launch: { exe: 'C:/l.exe' }, ready: { url: 'http://127.0.0.1:8188/y' } },
    ],
  }, deps, dir)
  const res = await runtime.requestStart('lm')
  assert.equal(res.accepted, false)
  assert.match(res.reason, /同族互斥/)
})

await test('停止只杀本插件记住的 PID', async () => {
  const dir = tempDir()
  const { deps, killed } = makeFakeEnv({ portPids: [4242] })
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{
      id: 'comfyui',
      launch: { exe: process.execPath, args: ['-e', ''], cwd: dir },
      ready: { url: 'http://127.0.0.1:8188/x', timeoutMs: 2000, intervalMs: 200 },
      logFile: join(dir, 'comfyui.log'),
    }],
  }, deps, dir)
  const res = await runtime.requestStop('comfyui')
  assert.equal(res.stopped, false)
  assert.deepEqual(killed, [])
})

await test('无端口 GUI 程序：只判自己的 PID 消失，不被同名的外部实例影响', async () => {
  // 复现 2026-11-09 的真实事故：用户手动起的 Blender（24340）与插件起的
  // Blender（16156）同名并存。插件只杀自己的，但旧实现杀完后仍用
  // listeningPids 轮询"还有没有 blender.exe"——24340 一直在，而 portOf()
  // 对无端口程序返回 null，于是必然报「端口 null 在 20000ms 内未释放」，
  // 把一次成功的停止伪装成失败。修复后即使同名进程仍在，也应报成功。
  const dir = tempDir()
  const killed = []
  const ourPid = 16156
  const foreignPid = 24340
  const BLENDER_EXE = 'E:\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe'
  let ourAlive = true

  const listPids = async () => (ourAlive ? [foreignPid, ourPid] : [foreignPid])
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{
      id: 'blender',
      name: 'Blender',
      launch: { exe: BLENDER_EXE },
      ready: { url: '' },
      stopTimeoutMs: 3000,
      logFile: join(dir, 'blender.log'),
    }],
  }, {
    sysinfo: {
      queryGpu: async () => ({ utilPct: 3, usedMiB: 500, totalMiB: 16303, freeMiB: 15803 }),
      queryGpuName: async () => 'Fake RTX',
      queryGpuProcesses: async () => [],
      queryCpuLoad: async () => 6,
    },
    status: {
      probeReady: async () => ({ ready: null, byProcess: true, status: null }),
      listeningPids: listPids,
    },
    programs: {
      listeningPids: listPids,
      killProcessTree: async (pid) => {
        killed.push(pid)
        if (pid === ourPid) ourAlive = false
        return { ok: true }
      },
      // 只有 ourPid 有 exe 路径；外部实例读不到（模拟权限不足）
      processExePath: async (pid) => (pid === ourPid && ourAlive ? BLENDER_EXE : null),
      pidsByProcessName: async () => (ourAlive ? [foreignPid, ourPid] : [foreignPid]),
    },
    edit: { probe: ALWAYS_EXISTS },
  }, dir)

  // 让 registry 记住我们的 PID，模拟本插件启动过
  runtime.registry.stateOf('blender').child = { pid: ourPid, exitCode: null }

  const res = await runtime.requestStop('blender')
  assert.deepEqual(killed, [ourPid], '只应杀掉本插件启动的 PID')
  assert.equal(res.stopped, true, `应报成功，实际：${res.reason}`)
  assert.doesNotMatch(String(res.reason), /未释放/)
  assert.doesNotMatch(String(res.reason), /端口 null/)
})

await test('无端口 GUI 程序：自己的 PID 杀不掉时明确报未退出', async () => {
  const dir = tempDir()
  const ourPid = 16156
  const BLENDER_EXE = 'E:\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe'
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{
      id: 'blender',
      name: 'Blender',
      launch: { exe: BLENDER_EXE },
      ready: { url: '' },
      stopTimeoutMs: 600,
      logFile: join(dir, 'blender-2.log'),
    }],
  }, {
    sysinfo: {
      queryGpu: async () => ({ utilPct: 3, usedMiB: 500, totalMiB: 16303, freeMiB: 15803 }),
      queryGpuName: async () => 'Fake RTX',
      queryGpuProcesses: async () => [],
      queryCpuLoad: async () => 6,
    },
    status: {
      probeReady: async () => ({ ready: null, byProcess: true, status: null }),
      listeningPids: async () => [ourPid],
    },
    programs: {
      listeningPids: async () => [ourPid],
      killProcessTree: async () => ({ ok: false, reason: '存取被拒' }),
      processExePath: async () => BLENDER_EXE,
      pidsByProcessName: async () => [ourPid],
    },
    edit: { probe: ALWAYS_EXISTS },
  }, dir)
  runtime.registry.stateOf('blender').child = { pid: ourPid, exitCode: null }

  const res = await runtime.requestStop('blender')
  assert.equal(res.stopped, false)
  assert.match(String(res.reason), /未退出|停止失败/)
})

await test('无端口程序的归属文案不再出现「端口 null」', async () => {
  // 文案事故：Blender 拒绝停止时输出「端口 null 被 PID 24340 占用」，
  // 让人以为端口配置坏了。无端口程序的句子必须说"进程"。
  const dir = tempDir()
  const BLENDER_EXE = 'E:\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe'
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{
      id: 'blender',
      name: 'Blender',
      launch: { exe: BLENDER_EXE },
      ready: { url: '' },
      stopTimeoutMs: 500,
      logFile: join(dir, 'blender-3.log'),
    }],
  }, {
    sysinfo: {
      queryGpu: async () => ({ utilPct: 3, usedMiB: 500, totalMiB: 16303, freeMiB: 15803 }),
      queryGpuName: async () => 'Fake RTX',
      queryGpuProcesses: async () => [],
      queryCpuLoad: async () => 6,
    },
    status: {
      probeReady: async () => ({ ready: null, byProcess: true, status: null }),
      listeningPids: async () => [24340],
    },
    programs: {
      listeningPids: async () => [24340],
      killProcessTree: async () => ({ ok: true }),
      processExePath: async () => null,
      pidsByProcessName: async () => [24340],
    },
    edit: { probe: ALWAYS_EXISTS },
  }, dir)

  const res = await runtime.requestStop('blender')
  assert.equal(res.stopped, false)
  assert.match(String(res.reason), /进程|PID/)
  assert.doesNotMatch(String(res.reason), /端口 null/)
})

await test('Electron 壳 + 子进程后端：沿父链认领后端 PID，并杀掉根进程', async () => {
  // 复现 2026-11-09 的真实事故（ComfyUI Desktop）：
  // 插件 spawn 的根是 Electron 壳（记住 41620），但监听 8188 的是它派生的
  // 后端 python（22660）。精确 PID 比对不相等 → 旧实现把自己启动的服务
  // 判成"外部进程"而拒绝停止。修复后应沿父链认领，并同时杀掉根进程，
  // 否则 Electron 壳会变成没后端的空窗口留在任务管理器里。
  const dir = tempDir()
  const killed = []
  const SHELL_PID = 41620
  const BACKEND_PID = 22660
  const SHELL_EXE = 'C:\\Users\\wjm\\AppData\\Local\\Programs\\ComfyUI\\Comfy Desktop\\Comfy Desktop.exe'
  const BACKEND_EXE = 'F:\\program\\ComfyUI\\.venv\\Scripts\\python.exe'

  let backendAlive = true
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{
      id: 'comfyui',
      name: 'ComfyUI',
      launch: { exe: SHELL_EXE },
      ready: { url: 'http://127.0.0.1:8188/x', timeoutMs: 2000, intervalMs: 100 },
      stopTimeoutMs: 2500,
      logFile: join(dir, 'comfyui.log'),
    }],
  }, {
    sysinfo: {
      queryGpu: async () => ({ utilPct: 3, usedMiB: 500, totalMiB: 16303, freeMiB: 15803 }),
      queryGpuName: async () => 'Fake RTX',
      queryGpuProcesses: async () => [],
      queryCpuLoad: async () => 6,
    },
    status: {
      probeReady: async () => ({ ready: false, byProcess: false, status: null }),
      // 端口占用者只有后端；后端被杀死后端口释放
      listeningPids: async () => (backendAlive ? [BACKEND_PID] : []),
    },
    programs: {
      listeningPids: async () => (backendAlive ? [BACKEND_PID] : []),
      killProcessTree: async (pid) => {
        killed.push(pid)
        if (pid === BACKEND_PID) backendAlive = false
        return { ok: true }
      },
      // 根是壳的 exe；后端是 venv python —— 两者不同
      processExePath: async (pid) => (pid === SHELL_PID ? SHELL_EXE : BACKEND_EXE),
      pidsByProcessName: async () => [SHELL_PID],
      // 父链：后端 22660 的父是根 41620
      parentPidOf: async (pid) => (pid === BACKEND_PID ? SHELL_PID : null),
    },
    edit: { probe: ALWAYS_EXISTS },
  }, dir)

  runtime.registry.stateOf('comfyui').child = { pid: SHELL_PID, exitCode: null }

  const res = await runtime.requestStop('comfyui')
  assert.equal(res.stopped, true, `应能停自己启动的服务，实际：${res.reason}`)
  assert.ok(killed.includes(BACKEND_PID), `应杀掉后端 PID，实际杀了 ${killed.join(',')}`)
  assert.ok(killed.includes(SHELL_PID), `应同时杀掉 Electron 壳，避免留空窗口，实际杀了 ${killed.join(',')}`)
  assert.ok(!/外部进程|归属未知/.test(String(res.reason)), `不应判成外部进程：${res.reason}`)
})

await test('父链认领不放宽防误杀：无关进程仍被拒绝', async () => {
  // 沿父链匹配必须只认"能追溯到已记录 PID"的进程。一个既非本插件启动、
  // 父链也追溯不到根的进程，仍要拒绝停止（防 PID 复用导致误杀）。
  const dir = tempDir()
  const killed = []
  const UNRELATED = 9999
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{
      id: 'comfyui',
      name: 'ComfyUI',
      launch: { exe: 'C:\\x\\Comfy Desktop.exe' },
      ready: { url: 'http://127.0.0.1:8188/x', timeoutMs: 1000, intervalMs: 100 },
      stopTimeoutMs: 400,
      logFile: join(dir, 'comfyui-2.log'),
    }],
  }, {
    sysinfo: {
      queryGpu: async () => ({ utilPct: 3, usedMiB: 500, totalMiB: 16303, freeMiB: 15803 }),
      queryGpuName: async () => 'Fake RTX',
      queryGpuProcesses: async () => [],
      queryCpuLoad: async () => 6,
    },
    status: {
      probeReady: async () => ({ ready: false, byProcess: false, status: null }),
      listeningPids: async () => [UNRELATED],
    },
    programs: {
      listeningPids: async () => [UNRELATED],
      killProcessTree: async (pid) => (killed.push(pid), { ok: true }),
      processExePath: async () => 'C:\\other\\thing.exe',
      pidsByProcessName: async () => [],
      // 父链走到头也到不了任何"已记录 PID"
      parentPidOf: async (pid) => (pid === UNRELATED ? 1234 : null),
    },
    edit: { probe: ALWAYS_EXISTS },
  }, dir)

  const res = await runtime.requestStop('comfyui')
  assert.equal(res.stopped, false)
  assert.deepEqual(killed, [], '外部进程一个都不该杀')
  assert.match(String(res.reason), /归属未知|不是本插件启动/)
})

// ---------- verify（只读验证） ----------

section('verify 只读验证')

/** 构造一份最小的程序配置。 */
function fakeProgram(overrides = {}) {
  return {
    id: 'comfyui',
    name: 'ComfyUI',
    enabled: true,
    valid: true,
    launch: { exe: 'C:\\Apps\\Comfy Desktop.exe' },
    ready: { url: 'http://127.0.0.1:8188/system_stats' },
    logFile: join(tempDir(), 'x.log'),
    ...overrides,
  }
}

await test('verify：停干净时判 pass，三条证据都指向"没在跑"', async () => {
  const res = await verifyProgram(fakeProgram(), {
    expect: 'stopped',
    deps: {
      listeningPids: async () => [],
      pidsByProcessName: async () => [],
      processExePath: async () => null,
      parentPidOf: async () => null,
    },
  })
  assert.equal(res.verdict, 'pass', `应判通过，实际 problems=${JSON.stringify(res.problems)}`)
  assert.equal(res.problems.length, 0)
  assert.equal(res.evidence.length, 3)
})

await test('verify：端口仍在监听时判 fail 并指出端口', async () => {
  const res = await verifyProgram(fakeProgram(), {
    expect: 'stopped',
    deps: {
      listeningPids: async () => [999],
      pidsByProcessName: async () => [999],
      processExePath: async () => 'C:\\Apps\\Comfy Desktop.exe',
      parentPidOf: async () => null,
    },
  })
  assert.equal(res.verdict, 'fail')
  assert.ok(res.problems.some((p) => p.includes('8188')), `应指出端口，实际 ${JSON.stringify(res.problems)}`)
})

await test('verify：残留进程按"同名 exe"识别，不误报无关进程', async () => {
  // 关键防误报：进程表里同时有 ComfyUI 的进程和一堆无关进程，
  // 只应把 exe 匹配的那个算作残留。
  const res = await verifyProgram(fakeProgram({ ready: { url: '' } }), {
    expect: 'stopped',
    deps: {
      listeningPids: async () => [],
      pidsByProcessName: async () => [111, 222, 333],
      processExePath: async (pid) => {
        if (pid === 111) return 'C:\\Apps\\Comfy Desktop.exe' // 残留
        if (pid === 222) return 'C:\\Other\\unrelated.exe' // 无关
        return null // 读不到
      },
      parentPidOf: async () => null,
    },
  })
  assert.equal(res.verdict, 'fail', '有残留就该判失败')
  const pids = (res.residualProcesses ?? []).map((item) => item.pid)
  assert.deepEqual(pids, [111], `只应认出 111，实际 ${JSON.stringify(pids)}`)
})

await test('verify：后端 python 经父链算作残留，避免"壳没了后端还在"漏报', async () => {
  // ComfyUI 场景：壳进程 111 与后端 222。按 exe 名匹配不到后端
  // （它是 venv python），但它是 111 的后代 → 必须算残留。
  const res = await verifyProgram(fakeProgram({ ready: { url: '' } }), {
    expect: 'stopped',
    deps: {
      listeningPids: async () => [],
      pidsByProcessName: async () => [111, 222],
      processExePath: async (pid) => (pid === 111 ? 'C:\\Apps\\Comfy Desktop.exe' : 'F:\\venv\\python.exe'),
      parentPidOf: async (pid) => (pid === 222 ? 111 : null),
    },
  })
  const pids = (res.residualProcesses ?? []).map((item) => item.pid).sort()
  assert.deepEqual(pids, [111, 222], `壳与后端都该算残留，实际 ${JSON.stringify(pids)}`)
})

await test('verify：进程表读不到时判 unknown，不谎报"已停干净"', async () => {
  // null（读不到）与 []（确实没有）必须严格区分：
  // 读不到进程表时既不能说通过，也不该说失败。
  const res = await verifyProgram(fakeProgram({ ready: { url: '' } }), {
    expect: 'stopped',
    deps: {
      listeningPids: async () => null,
      pidsByProcessName: async () => null,
      processExePath: async () => null,
      parentPidOf: async () => null,
    },
  })
  assert.equal(res.verdict, 'unknown', '读不到证据应判 unknown')
  assert.equal(res.ok, false)
})

await test('verifyAll：汇总多个程序并统计 passed/failed', async () => {
  const cfg = {
    programs: [
      fakeProgram({ id: 'a', name: 'A', launch: { exe: 'C:\\a.exe' }, ready: { url: '' } }),
      fakeProgram({ id: 'b', name: 'B', launch: { exe: 'C:\\b.exe' }, ready: { url: '' } }),
    ],
  }
  const res = await verifyAll(cfg, {
    expect: 'stopped',
    deps: {
      listeningPids: async () => [],
      pidsByProcessName: async () => [],
      processExePath: async () => null,
      parentPidOf: async () => null,
    },
  })
  assert.equal(res.total, 2)
  assert.equal(typeof res.ok, 'boolean')
  assert.equal(res.passed + res.failed + res.unknown, res.total)
})

// ---------- tools ----------

section('tools')

await test('注册 5 个 tool', async () => {
  const registered = []
  const ctx = { tools: { register: (d) => (registered.push(d), () => {}) } }
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({ sampleCacheMs: 0, programs: [{ id: 'comfyui', name: 'ComfyUI', launch: { exe: 'C:/c.exe' }, needs: { gpuUtilPctMax: 10 } }] }, deps, dir)
  const disposers = registerLauncherTools(ctx, runtime)
  assert.equal(registered.length, 5)
  assert.deepEqual(registered.map((d) => d.name), ['system_status', 'app_list', 'app_start', 'app_stop', 'app_verify'])
  for (const def of registered) {
    assert.ok(def.description.length > 30)
    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.execute, 'function')
    assert.equal(typeof def.output.render, 'function')
  }
  assert.equal(disposers.length, 5)
})

await test('system_status 返回可读摘要', async () => {
  const registered = []
  const ctx = { tools: { register: (d) => (registered.push(d), () => {}) } }
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({ sampleCacheMs: 0, programs: [] }, deps, dir)
  registerLauncherTools(ctx, runtime)
  const value = await registered.find((d) => d.name === 'system_status').execute({}, {})
  assert.match(value.summary, /GPU：Fake RTX/)
  assert.match(value.summary, /内存：空闲/)
})

await test('app_start 门控拒绝返回 ok:false', async () => {  const registered = []
  const ctx = { tools: { register: (d) => (registered.push(d), () => {}) } }
  const dir = tempDir()
  const { deps } = makeFakeEnv({ gpu: { utilPct: 88, usedMiB: 14000, totalMiB: 16303, freeMiB: 2303 } })
  const runtime = makeRuntime({ sampleCacheMs: 0, programs: [{ id: 'a', launch: { exe: 'C:/a.exe' }, needs: { gpuUtilPctMax: 10 } }] }, deps, dir)
  registerLauncherTools(ctx, runtime)
  const value = await registered.find((d) => d.name === 'app_start').execute({ id: 'a' }, {})
  assert.equal(value.ok, false)
  assert.match(value.reason, /88%/)
})

await test('app_list 暴露 gate.action', async () => {
  const registered = []
  const ctx = { tools: { register: (d) => (registered.push(d), () => {}) } }
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({ sampleCacheMs: 0, programs: [{ id: 'a', name: 'A', launch: { exe: 'C:/a.exe' }, needs: { gpuUtilPctMax: 10 } }] }, deps, dir)
  registerLauncherTools(ctx, runtime)
  const value = await registered.find((d) => d.name === 'app_list').execute({}, {})
  assert.equal(value.programs[0].gate.action, 'start')
})

await test('app_list 对已在运行给 already-running', async () => {
  const registered = []
  const ctx = { tools: { register: (d) => (registered.push(d), () => {}) } }
  const dir = tempDir()
  const { deps } = makeFakeEnv({ onlineIds: ['a'] })
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{ id: 'a', launch: { exe: 'C:/a.exe' }, needs: { gpuUtilPctMax: 10 }, ready: { url: 'http://127.0.0.1:9100/health' } }],
  }, deps, dir)
  registerLauncherTools(ctx, runtime)
  const value = await registered.find((d) => d.name === 'app_list').execute({}, {})
  assert.equal(value.programs[0].gate.action, 'already-running')
})

// ---------- edit ----------

section('edit 校验')

await test('splitArgs 处理引号与空串', () => {
  assert.deepEqual(splitArgs('--port 8188'), ['--port', '8188'])
  assert.deepEqual(splitArgs('--p "D:\\my models" -x'), ['--p', 'D:\\my models', '-x'])
  assert.deepEqual(splitArgs(''), [])
})

await test('parseEnvText 解析 KEY=VALUE', () => {
  assert.deepEqual(parseEnvText('A=1\n# c\nB = two\nbroken\n\nC='), { A: '1', B: 'two', C: '' })
})

await test('validateProgram 拒绝各类非法输入', () => {
  assert.throws(() => validateProgram({ launch: { exe: 'C:/a.exe' } }), /名称/)
  assert.throws(() => validateProgram({ name: 'X' }), /启动路径/)
  assert.throws(() => validateProgram({ name: 'X', launch: { exe: 'C:/a.exe' }, ready: { url: 'bad' } }), /完整 URL/)
  assert.throws(() => validateProgram({ id: 'dup', name: 'X', launch: { exe: 'C:/a.exe' } }, { existing: ['dup'] }), /已被占用/)
  assert.throws(() => validateProgram({ name: 'X', launch: { exe: 'C:/a.exe' }, needs: { gpuUtilPctMax: -5 } }), /非负数/)
})

await test('validateProgram 允许修改自己', () => {
  const program = validateProgram({ id: 'same', name: 'X', launch: { exe: 'C:/a.exe' } }, { existing: ['same'], allowSameId: 'same' })
  assert.equal(program.id, 'same')
})

await test('deriveId 派生合法 id', () => {
  assert.equal(deriveId('ComfyUI'), 'comfyui')
  assert.equal(deriveId('LM Studio!'), 'lm-studio')
  assert.equal(deriveId('ComfyUI', ['comfyui']), 'comfyui-2')
  assert.equal(deriveId('中文名'), 'program-1')
  assert.equal(deriveId('我的脚本', ['program-1']), 'program-2')
})

await test('addProgram 新增并生成 id', () => {
  const result = addProgram({ programs: [] }, { name: 'ComfyUI', launch: { exe: 'C:/c.exe' } }, { probe: ALWAYS_EXISTS })
  assert.equal(result.program.id, 'comfyui')
})

await test('addProgram 接受字符串 args 与 env', () => {
  const result = addProgram({ programs: [] }, {
    name: 'X',
    launch: { exe: 'C:/a.exe', args: '--port 1234 --name "a b"', env: 'K=1\nJ=2' },
  }, { probe: ALWAYS_EXISTS })
  const saved = result.config.programs[0]
  assert.deepEqual(saved.launch.args, ['--port', '1234', '--name', 'a b'])
  assert.deepEqual(saved.launch.env, { K: '1', J: '2' })
})

await test('updateProgram 修改字段', () => {
  const result = updateProgram(
    { programs: [{ id: 'a', name: 'A', launch: { exe: 'C:/a.exe', args: [] } }] },
    'a',
    { id: 'a', name: 'A2', launch: { exe: 'C:/a2.exe', args: '' }, needs: { gpuUtilPctMax: 20 } },
    { probe: ALWAYS_EXISTS },
  )
  assert.equal(result.program.name, 'A2')
  assert.equal(result.config.programs[0].needs.gpuUtilPctMax, 20)
})

await test('updateProgram 找不到 id 报错', () => {
  assert.throws(() => updateProgram({ programs: [] }, 'nope', { name: 'X', launch: { exe: 'C:/x.exe' } }, { probe: ALWAYS_EXISTS }), /找不到条目/)
})

await test('removeProgram 删除 / 删不存在报错', () => {
  const base = { programs: [{ id: 'a' }, { id: 'b' }] }
  assert.equal(removeProgram(base, 'a').config.programs.length, 1)
  assert.throws(() => removeProgram(base, 'zzz'), /找不到条目/)
})

await test('updateGlobal 只接受白名单字段', () => {
  const next = updateGlobal({ enabled: true }, { enabled: false, evil: 1 })
  assert.equal(next.enabled, false)
  assert.equal(next.evil, undefined)
  assert.throws(() => updateGlobal({}, { conflictPolicy: 'kill-all' }), /reject/)
})

// ---------- 授权目录 ----------

section('授权目录')

await test('normalizeAllowedDirs 只收绝对路径并去重', () => {
  assert.deepEqual(
    normalizeAllowedDirs(['C:\\Apps\\', 'C:/Apps', '  C:\\Tools  ', 'relative\\path', '', null, 'D:\\']),
    ['C:\\Apps', 'C:\\Tools', 'D:\\'],
  )
})

await test('isAbsolutePath 识别盘符/UNC/POSIX', () => {
  assert.equal(isAbsolutePath('C:\\a'), true)
  assert.equal(isAbsolutePath('\\\\server\\share'), true)
  assert.equal(isAbsolutePath('/usr/local'), true)
  assert.equal(isAbsolutePath('relative'), false)
  assert.equal(isAbsolutePath('C:'), false)
})

await test('isPathAllowed 允许目录本身与子路径', () => {
  assert.equal(isPathAllowed('C:\\Apps', ['C:\\Apps']), true)
  assert.equal(isPathAllowed('C:\\Apps\\Comfy', ['C:\\Apps']), true)
  assert.equal(isPathAllowed('c:/apps/comfy/app.exe', ['C:\\Apps']), true)
})

await test('isPathAllowed 用路径边界防前缀误放行', () => {
  assert.equal(isPathAllowed('C:\\Apps2', ['C:\\Apps']), false)
  assert.equal(isPathAllowed('C:\\Apps2\\x.exe', ['C:\\Apps']), false)
})

await test('isPathAllowed 空白名单一律拒绝', () => {
  assert.equal(isPathAllowed('C:\\Windows', []), false)
  assert.equal(isPathAllowed('C:\\Windows', undefined), false)
})

await test('listAllowedDirectory 空白名单给可操作提示', async () => {
  await assert.rejects(
    () => listAllowedDirectory('', []),
    (e) => e.name === 'BrowseError' && e.code === 'no-allowed-dir',
  )
})

await test('listAllowedDirectory 拒绝白名单外路径', async () => {
  await assert.rejects(
    () => listAllowedDirectory('C:\\Windows\\System32', ['C:\\Apps']),
    (e) => e.code === 'not-allowed',
  )
})

await test('listAllowedDirectory 列出目录并标记可执行', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'run.bat'), '@echo off\r\n')
  writeFileSync(join(dir, 'readme.txt'), 'x')
  const listing = await listAllowedDirectory(dir, [dir])
  assert.equal(listing.entries.find((e) => e.name === 'run.bat').executable, true)
  assert.equal(listing.entries.find((e) => e.name === 'readme.txt').executable, false)
})

await test('parentOf 到盘符根返回 null', () => {
  assert.equal(parentOf('C:\\'), null)
  assert.equal(parentOf('C:\\Apps'), 'C:\\')
})

await test('assertLaunchPathAllowed 拦白名单外路径', () => {
  assert.throws(() => assertLaunchPathAllowed('D:\\Other\\app.exe', ['C:\\Apps']), (e) => e.code === 'not-allowed')
  assert.doesNotThrow(() => assertLaunchPathAllowed('C:\\Apps\\app.exe', ['C:\\Apps']))
})

await test('updateGlobal 接受 allowedDirs 并拒绝相对路径', () => {
  assert.throws(() => updateGlobal({}, { allowedDirs: ['C:\\Apps', 'rel'] }), /绝对路径/)
  assert.throws(() => updateGlobal({}, { allowedDirs: 'not-array' }), /数组/)
  assert.deepEqual(updateGlobal({}, { allowedDirs: ['C:\\Apps', 'C:\\Apps\\', 'c:/apps'] }).allowedDirs, ['C:\\Apps'])
})

section('每程序授权目录')

await test('effectiveAllowedDirs = 程序自己的 ∪ 全局兜底', () => {
  const dirs = effectiveAllowedDirs({ allowedDirs: ['C:\\Shared'] }, { allowedDirs: ['F:\\Models', 'C:\\Shared'] })
  assert.deepEqual(dirs, ['F:\\Models', 'C:\\Shared'])
})

await test('不同程序互不共享授权目录', () => {
  const cfg = { allowedDirs: [] }
  const comfy = { allowedDirs: ['F:\\Comfy\\models'] }
  const blender = { allowedDirs: ['E:\\Blender'] }
  assert.deepEqual(effectiveAllowedDirs(cfg, comfy), ['F:\\Comfy\\models'])
  assert.equal(isPathAllowed('F:\\Comfy\\models', effectiveAllowedDirs(cfg, blender)), false)
})

await test('validateProgramPaths 拒绝不存在的启动路径', () => {
  const dir = tempDir()
  assert.throws(
    () => validateProgramPaths({ launch: { exe: join(dir, 'nope.exe'), cwd: '', cwdExplicit: false } }),
    /启动路径不存在/,
  )
})

await test('validateProgramPaths 接受真实存在的文件', () => {
  const dir = tempDir()
  const exe = join(dir, 'app.bat')
  writeFileSync(exe, '@echo off\r\n')
  assert.doesNotThrow(() => validateProgramPaths({ launch: { exe, cwd: '', cwdExplicit: false } }))
})

await test('validateProgramPaths 拒绝把目录当启动路径', () => {
  const dir = tempDir()
  assert.throws(() => validateProgramPaths({ launch: { exe: dir, cwd: '', cwdExplicit: false } }), /是目录而不是文件/)
})

await test('validateProgramPaths 只校验显式填写的工作目录', () => {
  const dir = tempDir()
  const exe = join(dir, 'a.bat')
  writeFileSync(exe, 'x')
  assert.doesNotThrow(() => validateProgramPaths({ launch: { exe, cwd: join(dir, 'missing'), cwdExplicit: false } }))
  assert.throws(
    () => validateProgramPaths({ launch: { exe, cwd: join(dir, 'missing'), cwdExplicit: true } }),
    /工作目录不存在/,
  )
  assert.doesNotThrow(() => validateProgramPaths({ launch: { exe, cwd: dir, cwdExplicit: true } }))
})

await test('validateProgramPaths 拒绝相对路径与相对授权目录', () => {
  assert.throws(() => validateProgramPaths({ launch: { exe: 'relative.exe', cwd: '', cwdExplicit: false } }), /绝对路径/)
  const dir = tempDir()
  const exe = join(dir, 'a.bat')
  writeFileSync(exe, 'x')
  assert.throws(
    () => validateProgramPaths({ launch: { exe, cwd: '', cwdExplicit: false }, allowedDirs: ['rel'] }),
    /授权目录必须是绝对路径/,
  )
})

await test('addProgram 保存时执行路径验证', () => {
  assert.throws(
    () => addProgram({ programs: [] }, { name: 'X', launch: { exe: 'C:\\definitely\\missing\\a.exe' } }),
    /启动路径不存在/,
  )
})

// ---------- store ----------

section('store 持久化')

await test('首次运行用种子并落盘', () => {
  const dir = tempDir()
  const store = createConfigStore({ seed: { enabled: true, programs: [{ id: 'a', name: 'A', launch: { exe: 'C:/a.exe' } }] }, dataDir: dir })
  assert.equal(store.load().programs.length, 1)
  assert.equal(store.hasUserLayer(), true)
})

await test('save 后 load 读到新值', () => {
  const dir = tempDir()
  createConfigStore({ seed: { programs: [] }, dataDir: dir }).save({ enabled: false, programs: [{ id: 'b', name: 'B', launch: { exe: 'C:/b.exe' } }] })
  const loaded = createConfigStore({ seed: { programs: [] }, dataDir: dir }).load()
  assert.equal(loaded.enabled, false)
  assert.equal(loaded.programs[0].id, 'b')
})

await test('reset 回到种子', () => {
  const dir = tempDir()
  const seed = { enabled: true, programs: [{ id: 'seed', name: 'S', launch: { exe: 'C:/s.exe' } }] }
  const store = createConfigStore({ seed, dataDir: dir })
  store.load()
  store.save({ enabled: false, programs: [] })
  assert.equal(store.load().programs.length, 0)
  assert.equal(store.reset().programs.length, 1)
})

await test('吃掉 BOM', () => {
  const dir = tempDir()
  const store = createConfigStore({ seed: { programs: [] }, dataDir: dir })
  store.load()
  writeFileSync(store.path, '\uFEFF' + JSON.stringify({ programs: [{ id: 'z', name: 'Z', launch: { exe: 'C:/z.exe' } }] }), 'utf8')
  assert.equal(createConfigStore({ seed: { programs: [] }, dataDir: dir }).load().programs[0].id, 'z')
})

await test('程序级 allowedDirs 会被持久化并读回', () => {
  // 曾漏写这个字段：落盘时丢掉，重启后每个程序都没有授权目录
  const dir = tempDir()
  const seed = {
    programs: [{ id: 'comfyui', name: 'ComfyUI', launch: { exe: 'C:/c.exe' }, allowedDirs: ['F:\\models', 'F:\\output'] }],
  }
  assert.deepEqual(createConfigStore({ seed, dataDir: dir }).load().programs[0].allowedDirs, ['F:\\models', 'F:\\output'])
  // 换实例重读（模拟重启）
  const reopened = createConfigStore({ seed: { programs: [] }, dataDir: dir })
  assert.deepEqual(reopened.load().programs[0].allowedDirs, ['F:\\models', 'F:\\output'])
})

await test('launchable / launchHint 会被持久化并读回', () => {
  // 同一个坑的第二个字段：漏了它，重启后又尝试代拉 → 白等一轮超时
  const dir = tempDir()
  const seed = {
    programs: [{
      id: 'comfyui', name: 'ComfyUI', launch: { exe: 'C:/c.exe' },
      launchable: false, launchHint: '请从桌面启动',
    }],
  }
  const first = createConfigStore({ seed, dataDir: dir }).load().programs[0]
  assert.equal(first.launchable, false)
  assert.equal(first.launchHint, '请从桌面启动')

  const reopened = createConfigStore({ seed: { programs: [] }, dataDir: dir }).load().programs[0]
  assert.equal(reopened.launchable, false)
  assert.equal(reopened.launchHint, '请从桌面启动')
})

await test('launchable 缺省时落盘为 true', () => {
  const dir = tempDir()
  const seed = { programs: [{ id: 'a', name: 'A', launch: { exe: 'C:/a.exe' } }] }
  assert.equal(createConfigStore({ seed, dataDir: dir }).load().programs[0].launchable, true)
})

// ---------- 动态挂载 ----------

section('动态启用/禁用 tool')

await test('enabled 切换挂载/注销 tool', async () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  let mounted = null
  const runtime = new LauncherRuntime({
    seed: { enabled: true, sampleCacheMs: 0, programs: [{ id: 'a', launch: { exe: 'C:/a.exe' } }] },
    deps,
    dataDir: dir,
    mountTools: () => { mounted = ['s', 'l', 'st', 'sp']; return [() => { mounted = null }] },
    unmountTools: (disposers) => { for (const d of disposers) d() },
  })
  assert.equal(runtime.toolsMounted, true)
  runtime.setGlobal({ enabled: false })
  assert.equal(runtime.toolsMounted, false)
  assert.equal(mounted, null)
  runtime.setGlobal({ enabled: true })
  assert.equal(runtime.toolsMounted, true)
})

await test('全局禁用时仍可查询配置', () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({
    enabled: false, sampleCacheMs: 0,
    programs: [{ id: 'a', name: 'A', launch: { exe: 'C:/a.exe' } }],
  }, deps, dir)
  const cfg = runtime.currentConfig()
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.programs.length, 1)
  assert.ok(cfg.path.includes('config.json'))
})

await test('配置目录不可写时不崩溃', () => {
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({ enabled: true, programs: [] }, deps, '\u0000invalid')
  assert.doesNotThrow(() => runtime.setGlobal({ enabled: false }))
  assert.equal(runtime.cfg.enabled, false)
  assert.equal(runtime.currentConfig().persisted, false)
})

await test('改条目立即体现且 revision 递增', () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({ programs: [] }, deps, dir)
  const before = runtime.currentConfig().revision
  assert.equal(runtime.addEntry({ name: 'MyTool', launch: { exe: 'C:/t.exe' } }).program.id, 'mytool')
  runtime.updateEntry('mytool', { id: 'mytool', name: 'MyTool2', launch: { exe: 'C:/t2.exe' } })
  assert.equal(runtime.cfg.programs[0].name, 'MyTool2')
  runtime.removeEntry('mytool')
  assert.equal(runtime.cfg.programs.length, 0)
  assert.ok(runtime.currentConfig().revision > before)
})

await test('browse 按程序授权范围（不串到别的程序）', async () => {
  const dir = tempDir()
  const ownDir = join(dir, 'comfy-models')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(join(ownDir, 'x.txt'), 'x')
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [
      { id: 'comfyui', launch: { exe: 'C:/c.exe' }, allowedDirs: [ownDir] },
      { id: 'blender', launch: { exe: 'C:/b.exe' }, allowedDirs: [] },
    ],
  }, deps, dir)
  // comfyui 有自己的授权目录 → 可浏览
  const listing = await runtime.browse(ownDir, 'comfyui')
  assert.equal(listing.path, ownDir)
  // blender 在这个 runtime 里没授权 → 拒绝
  await assert.rejects(() => runtime.browse(ownDir, 'blender'), (e) => e.code === 'no-allowed-dir')

  // 另起一个独立 dataDir（避免读到上一个 runtime 落盘的用户层），
  // 让 blender 授权到别的目录：它仍看不到 comfyui 的目录
  const dir2 = tempDir()
  const other = join(dir2, 'blender-dir')
  mkdirSync(other, { recursive: true })
  const runtime2 = makeRuntime({
    sampleCacheMs: 0,
    programs: [{ id: 'blender', launch: { exe: 'C:/b.exe' }, allowedDirs: [other] }],
  }, deps, dir2)
  await assert.rejects(() => runtime2.browse(ownDir, 'blender'), (e) => e.code === 'not-allowed')
})

// ---------- HTTP 同源 ----------

section('http 同源')

await test('回环 Host + 一致 Origin 放行', () => {
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:55053', origin: 'http://127.0.0.1:55053' } }), true)
  assert.equal(isSameOrigin({ headers: { host: 'localhost:55053', origin: 'http://127.0.0.1:55053' } }), true)
})

await test('无 Origin / dsh-app: 放行', () => {
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:55053' } }), true)
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:55053', origin: 'dsh-app://x' } }), true)
})

await test('跨源与外部 Host 拒绝', () => {
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:55053', origin: 'http://evil.com' } }), false)
  assert.equal(isSameOrigin({ headers: {} }), false)
})

// ---------- 只能手动启动的程序 ----------

section('manual-only 程序')

await test('launchable=false 时拒绝启动并给出原因', async () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{
      id: 'comfyui', name: 'ComfyUI', launchable: false,
      launchHint: '请从桌面图标启动',
      launch: { exe: 'C:/c.exe' },
      needs: { gpuUtilPctMax: 10 },
      ready: { url: 'http://127.0.0.1:8188/x' },
    }],
  }, deps, dir)
  await assert.rejects(
    () => runtime.requestStart('comfyui'),
    (error) => /需要手动启动/.test(error.message) && /桌面图标/.test(error.message),
  )
})

await test('launchable 默认 true（未声明就能启动）', () => {
  const program = normalizeProgram({ id: 'a', launch: { exe: 'C:/a.exe' } })
  assert.equal(program.launchable, true)
})

await test('快照暴露 launchable 供界面禁用按钮', async () => {
  const dir = tempDir()
  const { deps } = makeFakeEnv()
  const runtime = makeRuntime({
    sampleCacheMs: 0,
    programs: [{
      id: 'comfyui', name: 'ComfyUI', launchable: false, launchHint: '桌面启动',
      launch: { exe: 'C:/c.exe' }, ready: { url: 'http://127.0.0.1:8188/x' },
    }],
  }, deps, dir)
  const snap = await runtime.snapshot({ fresh: true })
  assert.equal(snap.programs[0].launchable, false)
  assert.equal(snap.programs[0].launchHint, '桌面启动')
})

// ---------- 秒退诊断 ----------

section('秒退诊断')

await test('无探针程序秒退时立即失败，不误报就绪', async () => {
  const dir = tempDir()
  const logFile = join(dir, 'quick.log')
  const program = normalizeProgram({
    id: 'quick',
    name: 'QuickQuitter',
    launch: { exe: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir },
    ready: { url: '', timeoutMs: 15000, intervalMs: 500 },
    logFile,
  })
  const registry = createRegistry()
  const state = registry.stateOf(program.id)
  const started = Date.now()
  await assert.rejects(
    () => ensureRunning(program, state, { log: () => {} }),
    (error) => /进程已退出/.test(error.message),
  )
  // 关键：不该等到 15s 超时才失败
  const elapsed = Date.now() - started
  assert.ok(elapsed < 8000, `应在秒级失败，实际 ${elapsed}ms`)

  // 日志必须留下诊断（这是"日志空白"bug 的回归测试）
  const { readFileSync: rf } = await import('node:fs')
  const text = rf(logFile, 'utf8')
  assert.match(text, /===== 启动 QuickQuitter =====/)
  assert.match(text, /命令:/)
  assert.match(text, /\[进程退出\]/)
  assert.match(text, /\[启动失败\]/)
})

await test('MIN_LIVENESS_MS 已被导出且大于 0', async () => {
  const mod = await import('../lib/programs.mjs')
  assert.ok(Number.isFinite(mod.MIN_LIVENESS_MS))
  assert.ok(mod.MIN_LIVENESS_MS > 0)
})

// ---------- Electron 宿主环境变量 ----------

section('Electron 宿主变量剔除')

await test('buildChildEnv 剔除 ELECTRON_RUN_AS_NODE（否则 Electron GUI 秒退）', async () => {
  // 2026-11-09 真事故：DSH 宿主注入该变量，子进程继承后
  // Comfy Desktop 以纯 Node 模式启动，57ms 退出、无任何输出。
  const mod = await import('../lib/programs.mjs')
  const original = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const env = mod.buildChildEnv({ launch: { env: {} } }, '')
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, '必须剔除')
  } finally {
    if (original === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = original
  }
})

await test('buildChildEnv 叠加用户显式 env 且用户优先', async () => {
  const mod = await import('../lib/programs.mjs')
  const env = mod.buildChildEnv({ launch: { env: { MY_VAR: 'abc', PATH: 'X' } } }, '')
  assert.equal(env.MY_VAR, 'abc')
  assert.equal(env.PATH, 'X', '用户显式值优先于继承值')
})

await test('buildChildEnv 按需前置 cwd 到 PATH', async () => {
  const mod = await import('../lib/programs.mjs')
  // Windows 环境变量名大小写不敏感：同一个变量可能以 Path/PATH 出现，
  // 所以按大小写不敏感取值，不能硬写 .PATH
  const readPath = (env) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
    return key ? env[key] : undefined
  }
  const withPrefix = readPath(mod.buildChildEnv({ launch: { env: {}, prependCwdToPath: true } }, 'C:\\Tools'))
  assert.ok(withPrefix?.startsWith('C:\\Tools;'), `实际: ${withPrefix}`)
  const noPrefix = readPath(mod.buildChildEnv({ launch: { env: {}, prependCwdToPath: false } }, 'C:\\Tools'))
  assert.ok(!noPrefix?.startsWith('C:\\Tools;'))
})

await test('strippedEnvKeys 只报告实际存在的变量', async () => {
  const mod = await import('../lib/programs.mjs')
  const original = process.env.ELECTRON_RUN_AS_NODE
  delete process.env.ELECTRON_RUN_AS_NODE
  try {
    assert.deepEqual(mod.strippedEnvKeys(), [], '没有该变量时不该报告')
    process.env.ELECTRON_RUN_AS_NODE = '1'
    assert.deepEqual(mod.strippedEnvKeys(), ['ELECTRON_RUN_AS_NODE'])
  } finally {
    if (original === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = original
  }
})

// ---------- 收尾 ----------

for (const dir of tmpDirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.log(`\nFAILED: ${name}\n${error?.stack ?? error}`)
  process.exit(1)
}
