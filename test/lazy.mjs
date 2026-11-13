/**
 * 懒加载测试：lazy 快照必须**不采样、不探针**，且不能污染完整快照的缓存。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LauncherRuntime } from '../lib/runtime.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-lazy-test-'))

let gpuCalls = 0
let probeCalls = 0
let pidCalls = 0

const rt = new LauncherRuntime({
  seed: {
    sampleCacheMs: 0,
    programs: [
      { id: 'app1', name: 'App1', launch: { exe: 'C:\\a.exe' }, ready: { url: 'http://127.0.0.1:8188/x' } },
      { id: 'app2', name: 'App2', launch: { exe: 'C:\\b.exe' }, needs: { gpuUtilPctMax: 10 } },
    ],
  },
  deps: {
    sysinfo: {
      queryGpu: async () => { gpuCalls += 1; return { utilPct: 3, usedMiB: 100, totalMiB: 16303, freeMiB: 16203 } },
      queryGpuName: async () => 'Fake',
      queryGpuProcesses: async () => [],
      queryCpuLoad: async () => 5,
    },
    status: {
      probeReady: async () => { probeCalls += 1; return { ready: false, byProcess: false } },
      listeningPids: async () => { pidCalls += 1; return [] },
    },
    programs: { listeningPids: async () => [], killProcessTree: async () => ({ ok: true }), processExePath: async () => null },
    edit: { probe: () => ({ exists: true, isDirectory: false }) },
  },
  dataDir: dir,
})

let passed = 0
const fails = []
function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ok  ' + name) }
  else { fails.push(name); console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')) }
}

console.log('=== lazy 快照不采样、不探针 ===')
const lazy = await rt.snapshot({ lazy: true })
check('没有调用 GPU 采样', gpuCalls === 0, `gpuCalls=${gpuCalls}`)
check('没有调用就绪探针', probeCalls === 0, `probeCalls=${probeCalls}`)
check('没有调用端口查询', pidCalls === 0, `pidCalls=${pidCalls}`)
check('system.lazy 标记为 true', lazy.system.lazy === true)
check('system.at 为 null（未采样）', lazy.system.at === null)
check('cpu 为 null', lazy.system.cpu === null)
check('程序列表仍完整', lazy.programs.length === 2)
check('程序静态路径仍在', lazy.programs[0].launch.exe === 'C:\\a.exe')
check('程序状态为 unknown（未探测）', lazy.programs[0].phase === 'unknown')
check('running 为 null（未知）', lazy.programs[0].running === null)
check('门控 action 为 unknown', lazy.gates.app1.action === 'unknown')
check('门控 ok 为 null（不下结论）', lazy.gates.app1.ok === null)

console.log('\n=== lazy 结果不污染完整快照缓存 ===')
const full = await rt.snapshot({ fresh: true })
check('完整快照重新采样了', gpuCalls > 0, `gpuCalls=${gpuCalls}`)
check('完整快照的 lazy 不是 true', full.system.lazy !== true)
check('完整快照有采样时间', typeof full.system.at === 'number')
check('完整快照做了探针', probeCalls > 0, `probeCalls=${probeCalls}`)
check('完整快照的门控有结论', full.gates.app2.ok !== null)

console.log('\n=== lazy 不会复用完整快照的缓存（否则等于做了采样） ===')
const gpuBefore = gpuCalls
const lazy2 = await rt.snapshot({ lazy: true })
check('lazy 仍然不采样', gpuCalls === gpuBefore, `gpuCalls=${gpuCalls}`)
check('lazy2 仍是未检查态', lazy2.system.lazy === true)

rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${passed} 项，失败 ${fails.length} 项`)
if (fails.length > 0) process.exit(1)
