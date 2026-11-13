/**
 * 门面完整性检查：HTTP 层用到的每个 runtime.xxx 都必须在 index.js 的门面里转发。
 *
 * 这是踩过的坑：门面是手写的，runtime 加了方法但忘了转发，
 * 运行时表现为 "rt.xxx is not a function"，而且只在点到那条路由时才炸。
 */
import { readFileSync } from 'node:fs'

const http = readFileSync('lib/http.mjs', 'utf8')
const index = readFileSync('lib/index.js', 'utf8')

// 1) http.mjs 里所有 rt.<name>( 形式的调用
const used = new Set()
for (const m of http.matchAll(/\brt\.([A-Za-z_$][\w$]*)\s*[(:]/g)) {
  used.add(m[1])
}
// runtime() 返回对象里的直接解构/访问
for (const m of http.matchAll(/\bruntime\(\)\.([A-Za-z_$][\w$]*)/g)) {
  used.add(m[1])
}

// 2) index.js 门面里出现的键（方法转发 + getter）
const provided = new Set()
for (const m of index.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) {
  provided.add(m[1])
}
for (const m of index.matchAll(/^\s*get\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
  provided.add(m[1])
}

const missing = [...used].filter((name) => !provided.has(name)).sort()

console.log('http.mjs 用到的 runtime 成员:', [...used].sort().join(', '))
console.log()
if (missing.length === 0) {
  console.log('✓ 门面完整：http 用到的成员都已转发')
} else {
  console.log('✗ 门面缺失（运行时会是 undefined）:')
  for (const name of missing) console.log('  -', name)
  process.exit(1)
}
