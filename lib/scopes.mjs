/**
 * dsh-app-launcher — 授权审计与旧作用域迁移。
 *
 * poolVersion 2 起授权模型收缩为**条目级会话授权**：
 * 每个「软件/脚本/目录」条目自带 sessions 列表，只有列进去的会话能用它。
 * 不再有 全局/工作区/会话 三层切片，也不再有全局授权目录。
 *
 * 这个文件现在只负责两件事：
 *  1. **授权记录（审计）**：谁在什么时候给哪个条目加/减了哪个会话的授权；
 *  2. **旧数据迁移**：读出旧 scopes.json 里的 workspaces/sessions 切片，
 *     交给 runtime 折叠进条目的 sessions 列表，然后清空切片（只留审计）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { pathKey } from './config.mjs'

export const SCOPE_FILE_VERSION = 1

/** 授权记录保留条数上限（防止无限增长）。 */
const MAX_GRANTS = 500

function emptyDoc() {
  return { version: SCOPE_FILE_VERSION, workspaces: {}, sessions: {}, grants: [], poolMigrated: false }
}

function readJson(path) {
  try {
    // 吃掉 BOM：PowerShell 5.1 / 记事本都可能写入 EF BB BF
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    return true
  } catch {
    // 目录不可写时不能崩：改动仅在内存生效，由上层告知用户
    return false
  }
}

/**
 * 授权审计存储（附带旧切片的一次性迁移读取）。
 *
 * @param {object} options { dataDir }
 */
export function createScopeStore({ dataDir }) {
  const path = join(dataDir, 'scopes.json')
  let cached = null

  function load() {
    if (cached) return cached
    const doc = readJson(path)
    cached = doc && doc.version === SCOPE_FILE_VERSION
      ? {
          version: SCOPE_FILE_VERSION,
          workspaces: doc.workspaces ?? {},
          sessions: doc.sessions ?? {},
          grants: Array.isArray(doc.grants) ? doc.grants : [],
          poolMigrated: doc.poolMigrated === true,
        }
      : emptyDoc()
    return cached
  }

  function persist(next) {
    cached = next
    writeJson(path, next)
    return next
  }

  return {
    path,

    /** 当前文档（只读快照）。 */
    snapshot() {
      return load()
    },

    /**
     * 旧三层切片是否还没折叠进条目池。
     * 迁移完成后（consumeLegacySlices）永远返回 false。
     */
    hasLegacySlices() {
      const doc = load()
      if (doc.poolMigrated) return false
      return Object.keys(doc.workspaces).length > 0 || Object.keys(doc.sessions).length > 0
    },

    /**
     * 读出旧切片供迁移：{ workspaces: {path: {allowedDirs, programs}}, sessions: {id: {...}} }。
     * 只读，不清空——清空由 consumeLegacySlices 在迁移成功后做。
     */
    legacySlices() {
      const doc = load()
      return { workspaces: doc.workspaces, sessions: doc.sessions }
    },

    /** 迁移完成：清空旧切片，只保留审计记录。 */
    consumeLegacySlices() {
      const doc = load()
      return persist({ ...doc, workspaces: {}, sessions: {}, poolMigrated: true })
    },

    /**
     * 追加一条授权记录（审计用）。
     *
     * 新模型下记录"哪个条目加/减了哪个会话的授权"：
     * scope 固定 'entry'，scopeKey=条目 id，target=会话 id（或 '*' 表示全部）。
     * 旧记录（scope=global/workspace/session）原样保留供查阅。
     */
    addGrant(entry) {
      const doc = load()
      const grant = {
        at: Date.now(),
        scope: String(entry.scope ?? 'entry'),
        scopeKey: entry.scopeKey ? String(entry.scopeKey) : '',
        kind: String(entry.kind ?? 'entry'), // entry | dir | program（旧）
        action: String(entry.action ?? 'add'), // add | remove | update | clear | migrate
        target: String(entry.target ?? ''),
        note: entry.note ? String(entry.note) : '',
      }
      const grants = [grant, ...doc.grants].slice(0, MAX_GRANTS)
      persist({ ...doc, grants })
      return grant
    },

    /** 最近的授权记录（新→旧）。 */
    grants(limit = 50) {
      const doc = load()
      const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 50
      return doc.grants.slice(0, n)
    },

    /** 落盘是否可用（dataDir 可写）。 */
    writable() {
      try {
        mkdirSync(dirname(path), { recursive: true })
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * 把多个目录列表并起来（保持顺序、去重）。
 *
 * @param {Array<string[]|undefined>} layerList 各来源的目录
 */
export function mergeDirs(...layerList) {
  const seen = new Set()
  const out = []
  for (const layer of layerList) {
    for (const dir of layer ?? []) {
      const key = pathKey(dir)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      out.push(dir)
    }
  }
  return out
}
