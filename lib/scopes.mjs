/**
 * dsh-app-launcher — 三级作用域授权（全局 / 工作区 / 会话）。
 *
 * 为什么需要：插件级配置是"一台机器一份"，但实际使用中授权粒度往往更细：
 *   - 某个工作区（比如 `D:\proj\comfy`）需要额外的模型目录；
 *   - 某一次会话只想临时加一个脚本，不想污染全局。
 *
 * 所以授权分三层，**生效范围 = 全局 ∪ 工作区 ∪ 会话**（并集，越具体越多）：
 *
 * | 作用域 | 存哪 | 谁写 | 生效范围 |
 * |---|---|---|---|
 * | global | `config.json`（既有两层配置） | 设置页「全部」 | 所有工作区所有会话 |
 * | workspace | `scopes.json` → `workspaces[<path>]` | 工作区导航栏入口 | 该工作区下所有会话 |
 * | session | `scopes.json` → `sessions[<id>]` | 会话顶部入口 | 仅当前会话 |
 *
 * 每层都能放两类东西：
 *   - `allowedDirs`：授权目录（Agent 可读写、设置页可浏览）
 *   - `programs`：软件/脚本条目（可直接被 app_start 拉起）
 *
 * 存储用**工作区路径**（canonical）而不是 workspaceId 作 key：工作区记录可以被
 * 删除再重建，而路径是稳定的；用 id 会让"重建同名工作区后授权丢失"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { normalizeAllowedDirs, normalizeProgram, pathKey } from './config.mjs'

export const SCOPE_FILE_VERSION = 1

/** 三种作用域。 */
export const SCOPES = ['global', 'workspace', 'session']

/** 授权记录保留条数上限（防止无限增长）。 */
const MAX_GRANTS = 500

function emptyDoc() {
  return { version: SCOPE_FILE_VERSION, workspaces: {}, sessions: {}, grants: [] }
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
 * 作用域存储。
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
        }
      : emptyDoc()
    return cached
  }

  function persist(next) {
    cached = next
    writeJson(path, next)
    return next
  }

  /** 归一化一个作用域切片（目录去重 + 条目归一化）。 */
  function normalizeSlice(raw) {
    const programsRaw = Array.isArray(raw?.programs) ? raw.programs : []
    return {
      allowedDirs: normalizeAllowedDirs(raw?.allowedDirs),
      programs: programsRaw.map((item, index) => normalizeProgram(item, index)),
    }
  }

  /** 读某一层的原始（未归一化）切片，供编辑表单回填。 */
  function rawSlice(scope, key) {
    const doc = load()
    if (scope === 'workspace') return doc.workspaces[key] ?? null
    if (scope === 'session') return doc.sessions[key] ?? null
    return null
  }

  return {
    path,

    /** 当前文档（只读快照）。 */
    snapshot() {
      return load()
    },

    /** 读一层的归一化切片；没有则返回空。 */
    slice(scope, key) {
      if (scope === 'global' || !key) {
        return { allowedDirs: [], programs: [] }
      }
      return normalizeSlice(rawSlice(scope, key))
    },

    rawSlice,

    /** 写一层（整体替换该层的两个字段）。 */
    setSlice(scope, key, slice) {
      if (scope === 'global' || !key) {
        throw new Error('global 层请走主配置，不在 scopes.json 里')
      }
      const doc = load()
      const bucket = scope === 'workspace' ? 'workspaces' : 'sessions'
      const normalized = normalizeSlice(slice)
      // 空切片就删掉这条，避免文件里堆积空壳
      const empty = normalized.allowedDirs.length === 0 && normalized.programs.length === 0
      const nextTable = { ...doc[bucket] }
      if (empty) delete nextTable[key]
      else nextTable[key] = normalized
      return persist({ ...doc, [bucket]: nextTable })
    },

    /** 删除整层。 */
    clearSlice(scope, key) {
      return this.setSlice(scope, key, { allowedDirs: [], programs: [] })
    },

    /**
     * 追加一条授权记录（审计用）。
     *
     * 记录的是"谁在哪个作用域加了什么"，用于设置页的「授权记录」面板与事后追查。
     */
    addGrant(entry) {
      const doc = load()
      const grant = {
        at: Date.now(),
        scope: String(entry.scope ?? 'global'),
        scopeKey: entry.scopeKey ? String(entry.scopeKey) : '',
        kind: String(entry.kind ?? 'dir'), // dir | program
        action: String(entry.action ?? 'add'), // add | remove | update | clear
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

    /** 列出所有有内容的作用域 key（供设置页展示"已授权的范围"）。 */
    keys() {
      const doc = load()
      return {
        workspaces: Object.keys(doc.workspaces),
        sessions: Object.keys(doc.sessions),
      }
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
 * 把三层的目录并起来（保持顺序、去重）。
 *
 * @param {Array<string[]|undefined>} layerList 各层的 allowedDirs
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

/**
 * 把三层的程序条目并起来。
 *
 * **同名（id）后者覆盖前者**：会话级可以覆盖工作区/全局的同 id 条目，
 * 这样"临时改一个参数"不需要先删掉全局那条。
 *
 * @param {Array<object[]|undefined>} layerList 各层的 programs（已归一化）
 * @returns {{ programs: object[], origin: Map<string,string> }}
 */
export function mergePrograms(...layerList) {
  const byId = new Map()
  const origin = new Map()
  const names = ['global', 'workspace', 'session']
  layerList.forEach((layer, index) => {
    for (const program of layer ?? []) {
      if (!program?.id) continue
      byId.set(program.id, program)
      origin.set(program.id, names[index] ?? 'global')
    }
  })
  return { programs: [...byId.values()], origin }
}
