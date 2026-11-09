/**
 * dsh-app-launcher — 授权目录下的文件浏览（宿主侧）。
 *
 * 为什么要在宿主侧做：宿主的 directoryPicker 在本机只装配了 native 能力
 * （`pickDirectory` 能开系统对话框，`listDirectory` 会报
 * "needs the browse capability"）。所以"在设置页里挑一个 exe"这件事，
 * 只能由插件自己列目录实现。
 *
 * 安全边界：**只允许浏览 allowedDirs 白名单内的路径**。
 * 空白名单 = 什么都不让看（提示去设置页添加），绝不退化成整盘可读。
 */
import { readdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, parse } from 'node:path'

import { isPathAllowed, pathKey } from './config.mjs'

/** 目录列举失败时的错误类型（HTTP 层映射成 400）。 */
export class BrowseError extends Error {
  constructor(message, code = 'browse-failed') {
    super(message)
    this.name = 'BrowseError'
    this.code = code
  }
}

/** 双击/点选即可直接当作启动路径的扩展名。 */
export const EXECUTABLE_EXTS = ['exe', 'bat', 'cmd', 'ps1', 'py', 'pyw', 'sh', 'lnk', 'jar']

/**
 * 取一个路径的上级目录；已是根（`C:\` 或 `/`）时返回 null。
 */
export function parentOf(dir) {
  if (!dir) return null
  const p = normalize(String(dir))
  const root = parse(p).root
  if (pathKey(p) === pathKey(root)) return null
  const parent = dirname(p)
  if (!parent || pathKey(parent) === pathKey(p)) return null
  return parent
}

function extOf(name) {
  const dot = String(name ?? '').lastIndexOf('.')
  return dot >= 0 ? String(name).slice(dot + 1).toLowerCase() : ''
}

/** 目录是否真的存在且可进入（同步探测，只用于排序过滤）。 */
function isDirectory(fullPath) {
  try {
    return statSync(fullPath).isDirectory()
  } catch {
    return false
  }
}

/**
 * 列出一个目录（仅限白名单内）。
 *
 * @param {string} target        要列的目录（绝对路径；空 = 取第一个授权目录）
 * @param {string[]} allowedDirs 白名单
 * @returns {Promise<{path, parent, home, crumbs, entries, allowedRoots, truncated}>}
 */
export async function listAllowedDirectory(target, allowedDirs) {
  const roots = Array.isArray(allowedDirs) ? allowedDirs : []
  if (roots.length === 0) {
    throw new BrowseError(
      '这个程序还没有授权目录。请在它的「授权目录」里加上要浏览的文件夹（只授权需要的几个，不是整盘）。',
      'no-allowed-dir',
    )
  }

  const wanted = String(target ?? '').trim()
  const dir = wanted === '' ? roots[0] : normalize(wanted)
  if (!isAbsolute(dir)) {
    throw new BrowseError(`只接受绝对路径：${dir}`, 'not-absolute')
  }
  if (!isPathAllowed(dir, roots)) {
    throw new BrowseError(
      `该目录不在这个程序的授权范围内：${dir}。要浏览它，请加到该程序的「授权目录」。`,
      'not-allowed',
    )
  }

  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = error?.code ?? ''
    if (code === 'ENOENT') throw new BrowseError(`目录不存在：${dir}`, 'not-found')
    if (code === 'EACCES' || code === 'EPERM') throw new BrowseError(`没有权限读取：${dir}`, 'denied')
    throw new BrowseError(`无法读取目录 ${dir}：${error?.message ?? error}`, 'read-failed')
  }

  const entries = []
  for (const d of dirents) {
    const full = join(dir, d.name)
    // Dirent 的 isDirectory 在部分网络盘上不可靠，目录额外用 stat 兜底一次
    const isDir = d.isDirectory() ? true : (d.isFile() ? false : isDirectory(full))
    entries.push({
      name: d.name,
      path: full,
      // 不用 kind 字段：宿主的 DirectoryEntry 只有 name/path/hidden，
      // 这里给出 isDirectory 是为了让前端排序与图标判断有据可依。
      isDirectory: isDir,
      hidden: String(d.name).startsWith('.'),
      executable: !isDir && EXECUTABLE_EXTS.includes(extOf(d.name)),
    })
  }

  // 目录在前、可执行文件靠前、其余按名字——找 exe 时不用翻很久
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    if (a.executable !== b.executable) return a.executable ? -1 : 1
    return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { numeric: true })
  })

  const MAX = 500
  return {
    path: dir,
    parent: parentOf(dir),
    home: roots[0],
    crumbs: [],
    entries: entries.slice(0, MAX),
    allowedRoots: roots.slice(),
    truncated: entries.length > MAX,
  }
}

/**
 * 校验一个"启动路径"是否可接受：必须绝对、且在授权目录内。
 * 保存条目时也用它，避免把白名单外的路径写进配置。
 */
export function assertLaunchPathAllowed(exePath, allowedDirs, { requireExist = false } = {}) {
  const text = String(exePath ?? '').trim()
  if (text === '') return
  if (!isAbsolute(text)) {
    throw new BrowseError('启动路径必须是绝对路径，例如 C:\\Program Files\\App\\app.exe', 'not-absolute')
  }
  const dir = dirname(normalize(text))
  if (!isPathAllowed(dir, allowedDirs) && !isPathAllowed(text, allowedDirs)) {
    throw new BrowseError(
      `启动路径所在目录不在授权范围内：${dir}。请先在设置页「授权目录」里加入它。`,
      'not-allowed',
    )
  }
  if (requireExist) {
    try {
      statSync(text)
    } catch {
      throw new BrowseError(`文件不存在：${text}`, 'not-found')
    }
  }
}
