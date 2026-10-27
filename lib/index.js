/**
 * dsh-settings-sync — host half.
 *
 * Синхронизация настроек DSH и установленных плагинов через приватный Git-
 * репозиторий (GitHub):
 *   - capture : DSH_HOME -> <repo>/home + <repo>/plugins, commit/push
 *   - pull    : забрать удалённые коммиты (с проверкой расхождения)
 *   - apply   : <repo> -> DSH_HOME (бэкап, локальные плагины, pnpm install)
 *   - restore : вернуть живые файлы из бэкапа или из коммита
 *   - scan    : показать найденные секреты в снапшоте
 *
 * Сознательно НЕ синхронизируются: .credentials.yaml, .env, sessions/,
 * storages/, node_modules/, dsh-runtimes/, cache/, attachments/.
 *
 * Файл — чистый ESM на встроенных модулях Node, без сборки.
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Имя плагина (совпадает с package.json и cordis.patch.yml). */
export const name = 'settings-sync'

/** Нужен только webServer для HTTP-маршрутов; tools/commands подключаются опционально. */
export const inject = ['webServer']

const API = '/api/dsh-settings-sync'
const SYNC_DIR = 'settings-sync'
const FORMAT_VERSION = 2
const MAX_BODY_BYTES = 256 * 1024
const GIT_TIMEOUT_MS = 10 * 60 * 1000
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const AUTO_TICK_MS = 60 * 1000
const MAX_LOCAL_PLUGIN_BYTES = 10 * 1024 * 1024

/** Файлы профиля, без которых не восстановить настройки и плагины. */
const DEFAULT_MANAGED = [
  'profiles/{profile}/package.json',
  'profiles/{profile}/pnpm-lock.yaml',
  'profiles/{profile}/pnpm-workspace.yaml',
  'profiles/{profile}/cordis.patch.yml',
]
const DEFAULT_OPTIONAL_DIRS = ['skills', 'agents']
const DEFAULT_OPTIONAL_FILES = [
  'AGENTS.md',
  'settings.yaml',
  'pet.json',
  'skin-center-active.json',
]

const ALL_CATEGORIES = {
  settings: true,
  plugins: true,
  skills: true,
  instructions: true,
}

const DEFAULT_SETTINGS = {
  repoUrl: '',
  branch: 'main',
  token: '',
  profile: '',
  repoDir: '',
  autoOnStart: false,
  autoOnChange: false,
  autoPush: false,
  intervalMinutes: 10,
  debounceMs: 6000,
  categories: { ...ALL_CATEGORIES },
}

const SKIP_RE = /(^|\/)(node_modules|\.git|\.dsh-market|\.cache|\.DS_Store)(\/|$)/
const PLUGIN_SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'coverage', '.cache', 'dist-test'])
const TEXT_EXT = new Set([
  '.yml', '.yaml', '.json', '.md', '.txt', '.toml', '.ini', '.conf',
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.css',
  '.html', '.htm', '.svg', '.sh', '.ps1', '.env', '.lock', '.json5',
])

const SECRET_PATTERNS = [
  { name: 'AI key', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Bearer', re: /Bearer\s+[A-Za-z0-9._-]{20,}/i },
  {
    name: 'key/token/password',
    re: /(api[_-]?key|access[_-]?token|secret|password|passwd|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{12,}/i,
  },
]

/** Один синхронизирующий процесс за раз. */
const state = {
  busy: false,
  lastOp: null,
  lastAutoAt: 0,
  lastAutoChangeAt: 0,
}

// ─────────────────────────── пути ───────────────────────────

function homeRoot() {
  const explicit = process.env.DSH_HOME
  return explicit && explicit.trim() ? resolve(explicit.trim()) : join(homedir(), '.dsh')
}

function syncRoot() {
  return join(homeRoot(), SYNC_DIR)
}

function settingsFile() {
  return join(syncRoot(), 'settings.json')
}

function repoPath(settings) {
  const override = settings && settings.repoDir ? String(settings.repoDir).trim() : ''
  return override ? resolve(override) : join(syncRoot(), 'repo')
}

function backupRoot() {
  return join(syncRoot(), 'backups')
}

function extensionsRoot() {
  return join(syncRoot(), 'extensions')
}

function askpassFile() {
  return join(syncRoot(), '.askpass.sh')
}

function dshVersionPath(home) {
  return join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json')
}

// ─────────────────────────── утилиты ───────────────────────────

function existsSync(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function readJson(p) {
  return JSON.parse(await fsp.readFile(p, 'utf8'))
}

async function writeTextAtomic(p, text, mode) {
  await fsp.mkdir(dirname(p), { recursive: true, mode: 0o700 })
  const tmp = p + '.tmp-' + randomUUID()
  await fsp.writeFile(tmp, text, mode === undefined ? undefined : { mode })
  await fsp.rename(tmp, p)
  if (mode !== undefined) {
    try {
      await fsp.chmod(p, mode)
    } catch {
      /* chmod может быть недоступен (Windows) */
    }
  }
}

async function writeJsonAtomic(p, value, mode) {
  await writeTextAtomic(p, JSON.stringify(value, null, 2) + '\n', mode)
}

async function writeTextIfMissing(p, text) {
  if (await exists(p)) return
  await fsp.mkdir(dirname(p), { recursive: true })
  await fsp.writeFile(p, text, 'utf8')
}

function hashFile(p) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(p)
    stream.on('error', rejectPromise)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

function toPosix(p) {
  return p.split(sep).join('/')
}

function relFrom(base, full) {
  const rel = relative(resolve(base), resolve(full))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('путь вне базовой папки: ' + full)
  return toPosix(rel)
}

function isTextRel(rel) {
  const dot = rel.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXT.has(rel.slice(dot).toLowerCase())
}

function skipPluginRel(rel) {
  return rel.split('/').some((part) => PLUGIN_SKIP_DIRS.has(part))
}

function shouldSkip(rel) {
  if (SKIP_RE.test(rel)) return true
  const base = rel.split('/').pop() || ''
  if (base === 'cordis.yml') return true
  if (/\.(log|tmp)$/.test(base)) return true
  if (base === 'Thumbs.db' || base === '.DS_Store') return true
  return false
}

function tail(text, max) {
  const value = String(text || '').trim()
  return value.length > max ? value.slice(value.length - max) : value
}

function makeError(statusCode, message, code) {
  const error = new Error(message)
  error.statusCode = statusCode
  if (code) error.code = code
  return error
}

function runCommand(file, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env || process.env,
        timeout: options.timeout || 20000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(tail(String(stderr || '') || error.message, 600)))
          return
        }
        resolvePromise(String(stdout || ''))
      },
    )
  })
}

// ─────────────────────────── шаблоны путей ───────────────────────────

/**
 * Абсолютные пути дома заменяются на ${DSH_HOME} / ${HOME}, чтобы снапшот
 * не ломался на машине с другим путём. Порядок важен: сначала DSH_HOME.
 */
function encodePaths(text) {
  if (typeof text !== 'string' || !text) return text
  let out = text
  const home = homeRoot()
  const user = homedir()
  if (home) out = out.split(home).join('${DSH_HOME}')
  if (user && user !== home) out = out.split(user).join('${HOME}')
  return out
}

function decodePaths(text) {
  if (typeof text !== 'string' || !text) return text
  return text.split('${DSH_HOME}').join(homeRoot()).split('${HOME}').join(homedir())
}

async function readRepoText(p) {
  return decodePaths(await fsp.readFile(p, 'utf8'))
}

// ─────────────────────────── настройки ───────────────────────────

async function loadSettings() {
  let raw = null
  try {
    raw = await readJson(settingsFile())
  } catch {
    raw = null
  }
  const settings = { ...DEFAULT_SETTINGS, categories: { ...ALL_CATEGORIES } }
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === 'categories') continue
      const value = raw[key]
      if (value === undefined || value === null) continue
      if (typeof value === typeof DEFAULT_SETTINGS[key]) settings[key] = value
    }
    if (raw.categories && typeof raw.categories === 'object') {
      for (const key of Object.keys(ALL_CATEGORIES)) {
        if (raw.categories[key] !== undefined) settings.categories[key] = Boolean(raw.categories[key])
      }
    }
  }
  if (!Number.isFinite(settings.intervalMinutes) || settings.intervalMinutes < 2) settings.intervalMinutes = 10
  if (!Number.isFinite(settings.debounceMs) || settings.debounceMs < 1000) settings.debounceMs = 6000
  return settings
}

function splitUrlCredentials(url) {
  const value = String(url || '').trim()
  const match = /^(https?:\/\/)([^/@\s]+)@(.+)$/i.exec(value)
  if (!match) return { url: value, token: '' }
  const userinfo = match[2]
  const raw = userinfo.includes(':') ? userinfo.slice(userinfo.indexOf(':') + 1) : userinfo
  let token = raw
  try {
    token = decodeURIComponent(raw)
  } catch {
    /* оставить как есть */
  }
  return { url: match[1] + match[3], token }
}

async function saveSettings(patch) {
  const current = await loadSettings()
  const next = { ...current, categories: { ...current.categories } }
  if (patch && typeof patch === 'object') {
    if (patch.repoUrl !== undefined) {
      const parsed = splitUrlCredentials(patch.repoUrl === null ? '' : patch.repoUrl)
      next.repoUrl = parsed.url
      if (parsed.token) next.token = parsed.token
    }
    for (const key of ['branch', 'repoDir', 'profile']) {
      if (patch[key] === undefined) continue
      next[key] = patch[key] === null ? '' : String(patch[key]).trim()
    }
    if (patch.token !== undefined && patch.token !== null && String(patch.token) !== '') {
      next.token = String(patch.token)
    }
    if (patch.clearToken === true) next.token = ''
    for (const key of ['autoOnStart', 'autoOnChange', 'autoPush']) {
      if (patch[key] !== undefined) next[key] = Boolean(patch[key])
    }
    for (const key of ['intervalMinutes', 'debounceMs']) {
      if (patch[key] === undefined) continue
      const n = Number(patch[key])
      if (Number.isFinite(n)) next[key] = Math.max(2, Math.min(1440, Math.round(n)))
    }
    if (patch.categories && typeof patch.categories === 'object') {
      for (const key of Object.keys(ALL_CATEGORIES)) {
        if (patch.categories[key] !== undefined) next.categories[key] = Boolean(patch.categories[key])
      }
    }
  }
  if (!next.branch) next.branch = 'main'
  await writeJsonAtomic(settingsFile(), next, 0o600)
  return next
}

function publicSettings(settings) {
  return {
    repoUrl: settings.repoUrl,
    branch: settings.branch,
    profile: settings.profile,
    hasToken: Boolean(settings.token),
    autoOnStart: settings.autoOnStart,
    autoOnChange: settings.autoOnChange,
    autoPush: settings.autoPush,
    intervalMinutes: settings.intervalMinutes,
    debounceMs: settings.debounceMs,
    categories: { ...settings.categories },
    repoDir: settings.repoDir,
    syncDir: syncRoot(),
    dshHome: homeRoot(),
  }
}

// ─────────────────────────── профили и локальные плагины ───────────────────────────

async function getProfiles(home) {
  const dir = join(home, 'profiles')
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await exists(join(dir, entry.name, 'package.json'))) out.push(entry.name)
  }
  return out.sort()
}

function targetProfiles(profiles, settings) {
  if (settings && settings.profile) return profiles.filter((p) => p === settings.profile)
  return profiles
}

function specPath(spec) {
  const value = String(spec || '').trim()
  const match = /^(link|file):(.+)$/i.exec(value)
  if (!match) return null
  const raw = match[2].trim()
  return { kind: match[1].toLowerCase(), raw }
}

function safePluginDir(name) {
  return String(name).replace(/^@/, '').replace(/[\\/]/g, '--')
}

/**
 * Локальные плагины профиля: зависимости вида link:/abs/path или file:/abs/path.
 * Их исходники уезжают в репозиторий, чтобы на другой машине плагины
 * восстановились без npm-публикации.
 */
async function collectLocalPlugins(home, profiles, settings) {
  const byName = new Map()
  for (const profile of targetProfiles(profiles, settings)) {
    const profileDir = join(home, 'profiles', profile)
    let pkg
    try {
      pkg = await readJson(join(profileDir, 'package.json'))
    } catch {
      continue
    }
    const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
    for (const [depName, spec] of Object.entries(deps)) {
      const parsed = specPath(spec)
      if (!parsed) continue
      const source = isAbsolute(parsed.raw) ? parsed.raw : resolve(profileDir, parsed.raw)
      if (!(await exists(source))) continue
      let stat
      try {
        stat = await fsp.stat(source)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      const name = safePluginDir(depName)
      if (byName.has(name)) continue
      byName.set(name, {
        name: depName,
        dir: name,
        spec: String(spec),
        kind: parsed.kind,
        source,
        profile,
      })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function copyPluginTree(source, dest) {
  let bytes = 0
  async function walk(src, dst) {
    const entries = await fsp.readdir(src, { withFileTypes: true })
    await fsp.mkdir(dst, { recursive: true })
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue
      if (PLUGIN_SKIP_DIRS.has(entry.name)) continue
      const abs = join(src, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(abs, join(dst, entry.name))
      } else if (entry.isFile()) {
        const stat = await fsp.stat(abs)
        bytes += stat.size
        if (bytes > MAX_LOCAL_PLUGIN_BYTES) {
          throw makeError(413, 'локальный плагин больше ' + Math.round(MAX_LOCAL_PLUGIN_BYTES / 1024 / 1024) + ' МБ: ' + source)
        }
        await fsp.copyFile(abs, join(dst, entry.name))
      }
    }
  }
  await walk(source, dest)
  return bytes
}

async function walkFiles(root) {
  const out = []
  async function walk(dir) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        try {
          out.push(relFrom(root, abs))
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root)
  return out
}

// ─────────────────────────── конфиг репозитория ───────────────────────────

async function readRepoConfig(repo) {
  let raw = null
  try {
    raw = await readJson(join(repo, 'dshcfg.json'))
  } catch {
    raw = null
  }
  const localPlugins = raw && Array.isArray(raw.localPlugins)
    ? raw.localPlugins
        .filter((entry) => entry && entry.name)
        .map((entry) => ({
          name: String(entry.name),
          dir: String(entry.dir || safePluginDir(entry.name)),
          spec: String(entry.spec || ''),
          kind: String(entry.kind || 'link'),
        }))
    : []
  return { version: FORMAT_VERSION, localPlugins }
}

async function writeRepoConfig(repo, localPlugins) {
  await writeJsonAtomic(join(repo, 'dshcfg.json'), {
    version: FORMAT_VERSION,
    localPlugins: localPlugins.map((entry) => ({
      name: entry.name,
      dir: entry.dir,
      spec: entry.spec,
      kind: entry.kind,
    })),
  })
}

// ─────────────────────────── управления ───────────────────────────

/**
 * Полный список управляемых файлов: rel в снапшоте -> абсолютный путь на диске.
 * Файлы локальных плагинов лежат вне DSH_HOME, поэтому без этой карты
 * нельзя корректно ни хэшировать, ни копировать.
 */
async function managedEntries(home, settings, localPlugins = []) {
  const map = new Map()
  const categories = settings.categories || ALL_CATEGORIES
  const profiles = targetProfiles(await getProfiles(home), settings)
  const list = profiles.length ? profiles : ['desktop']
  for (const profile of list) {
    for (const pattern of DEFAULT_MANAGED) {
      if (!categories.settings && !categories.plugins) continue
      const rel = String(pattern).replace('{profile}', profile)
      if (shouldSkip(rel)) continue
      const abs = join(home, ...rel.split('/'))
      if (await exists(abs)) map.set(rel, abs)
    }
  }
  if (categories.skills) {
    for (const dir of DEFAULT_OPTIONAL_DIRS) {
      if (dir === 'agents' && !categories.settings) continue
      const abs = join(home, dir)
      if (await exists(abs)) await collectTree(home, abs, map)
    }
  }
  for (const file of DEFAULT_OPTIONAL_FILES) {
    if (file === 'AGENTS.md' && !categories.instructions) continue
    if (file === 'settings.yaml' && !categories.settings) continue
    const abs = join(home, file)
    if (await exists(abs)) map.set(file, abs)
  }
  if (categories.plugins) {
    for (const plugin of localPlugins) {
      const files = await walkFiles(plugin.source)
      for (const rel of files) {
        if (shouldSkip(rel) || skipPluginRel(rel)) continue
        map.set('plugins/' + plugin.dir + '/' + rel, join(plugin.source, ...rel.split('/')))
      }
    }
  }
  return map
}

async function managedRels(home, settings, localPlugins = []) {
  return [...(await managedEntries(home, settings, localPlugins)).keys()].sort()
}

async function collectTree(home, absDir, set) {
  let entries
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = join(absDir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await collectTree(home, abs, set)
    } else if (entry.isFile()) {
      let rel
      try {
        rel = relFrom(home, abs)
      } catch {
        continue
      }
      if (!shouldSkip(rel)) set.set(rel, abs)
    }
  }
}

async function hashLive(entries) {
  const map = new Map()
  for (const [rel, abs] of entries) {
    if (!(await exists(abs))) continue
    if (rel.startsWith('plugins/')) {
      map.set(rel, await hashFile(abs))
    } else if (isTextRel(rel)) {
      map.set(rel, hashText(encodePaths(await fsp.readFile(abs, 'utf8'))))
    } else {
      map.set(rel, await hashFile(abs))
    }
  }
  return map
}

async function hashRepo(repo) {
  const root = join(repo, 'home')
  const map = new Map()
  if (await exists(root)) {
    for (const rel of await walkFiles(root)) {
      const abs = join(root, ...rel.split('/'))
      map.set(rel, isTextRel(rel) ? hashText(await fsp.readFile(abs, 'utf8')) : await hashFile(abs))
    }
  }
  const pluginsRoot = join(repo, 'plugins')
  if (await exists(pluginsRoot)) {
    for (const rel of await walkFiles(pluginsRoot)) {
      map.set('plugins/' + rel, await hashFile(join(pluginsRoot, ...rel.split('/'))))
    }
  }
  return map
}

async function copyLiveToRepo(repo, rel, abs) {
  const dst = join(repo, 'home', ...rel.split('/'))
  await fsp.mkdir(dirname(dst), { recursive: true })
  if (isTextRel(rel) && !rel.startsWith('plugins/')) {
    await writeTextAtomic(dst, encodePaths(await fsp.readFile(abs, 'utf8')))
  } else {
    await fsp.copyFile(abs, dst)
  }
}

async function copyRepoToLive(home, repo, rel) {
  const src = join(repo, 'home', ...rel.split('/'))
  const dst = join(home, ...rel.split('/'))
  await fsp.mkdir(dirname(dst), { recursive: true })
  if (isTextRel(rel) && !rel.startsWith('plugins/')) {
    await writeTextAtomic(dst, decodePaths(await fsp.readFile(src, 'utf8')))
  } else {
    await fsp.copyFile(src, dst)
  }
}

// ─────────────────────────── Git ───────────────────────────

function cleanRemoteUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^(https?:\/\/)[^/@]+@/i, '$1')
}

async function ensureAskpass() {
  const file = askpassFile()
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    '  Username*) echo "${DSH_SETTINGS_SYNC_USER:-oauth2}" ;;',
    '  *) echo "$DSH_SETTINGS_SYNC_TOKEN" ;;',
    'esac',
    '',
  ].join('\n')
  await fsp.mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await fsp.writeFile(file, script, { mode: 0o755 })
  try {
    await fsp.chmod(file, 0o755)
  } catch {
    /* ignore */
  }
  return file
}

function gitEnv(settings, askpass) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (settings && settings.token) {
    env.GIT_ASKPASS = askpass
    env.DSH_SETTINGS_SYNC_TOKEN = settings.token
    env.DSH_SETTINGS_SYNC_USER = process.env.DSH_SETTINGS_SYNC_USER || 'oauth2'
  }
  return env
}

async function git(args, options = {}) {
  const { cwd, settings, allowFail = false } = options
  const askpass = settings && settings.token ? await ensureAskpass() : undefined
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: gitEnv(settings, askpass),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = String(stdout || '')
        const err = String(stderr || '')
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        if (error && !allowFail) {
          rejectPromise(
            new Error('git ' + args[0] + ' не удался' + (code ? ' (exit ' + code + ')' : '') + ': ' + tail(err || error.message, 400)),
          )
          return
        }
        resolvePromise({ code, stdout: out, stderr: err })
      },
    )
  })
}

async function ensureRemote(settings, repo) {
  if (!settings.repoUrl) return
  const url = cleanRemoteUrl(settings.repoUrl)
  const current = await git(['remote', 'get-url', 'origin'], { cwd: repo, settings, allowFail: true })
  if (current.code !== 0) {
    await git(['remote', 'add', 'origin', url], { cwd: repo, settings })
    return
  }
  if (current.stdout.trim() !== url) {
    await git(['remote', 'set-url', 'origin', url], { cwd: repo, settings })
  }
}

async function ensureRepo(settings) {
  const repo = repoPath(settings)
  const hasGit = await exists(join(repo, '.git'))
  await fsp.mkdir(repo, { recursive: true })
  if (!hasGit) {
    await git(['init', '-b', settings.branch || 'main'], { cwd: repo, settings })
    await writeTextIfMissing(join(repo, '.gitattributes'), '* -text\n')
    await writeTextIfMissing(
      join(repo, '.gitignore'),
      ['dshcfg.local.json', '.backups/', '*.log', 'Thumbs.db', '.DS_Store', ''].join('\n'),
    )
    await writeTextIfMissing(join(repo, 'dshcfg.json'), JSON.stringify({ version: FORMAT_VERSION, localPlugins: [] }, null, 2) + '\n')
  }
  const email = await git(['config', 'user.email'], { cwd: repo, allowFail: true })
  if (email.code !== 0 || !email.stdout.trim()) {
    await git(['config', 'user.email', 'dsh-settings-sync@localhost'], { cwd: repo })
    await git(['config', 'user.name', 'dsh-settings-sync'], { cwd: repo })
  }
  await ensureRemote(settings, repo)
  return repo
}

async function fetchRemote(repo, settings) {
  const result = await git(['fetch', 'origin'], { cwd: repo, settings, allowFail: true })
  return result.code === 0
}

async function aheadBehind(repo, settings, branch) {
  const branchName = branch || settings.branch || 'main'
  const result = await git(['rev-list', '--left-right', '--count', 'origin/' + branchName + '...HEAD'], {
    cwd: repo,
    settings,
    allowFail: true,
  })
  if (result.code !== 0) return { behind: null, ahead: null }
  const parts = result.stdout.trim().split(/\s+/)
  return { behind: Number(parts[0]) || 0, ahead: Number(parts[1]) || 0 }
}

async function gitSummary(repo, settings) {
  const summary = { branch: null, remote: null, dirty: 0, ahead: null, behind: null, head: null, diverged: false }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, settings, allowFail: true })
  summary.branch = branch.code === 0 ? branch.stdout.trim() : null
  const remote = await git(['remote', 'get-url', 'origin'], { cwd: repo, settings, allowFail: true })
  if (remote.code === 0) summary.remote = remote.stdout.trim()
  const status = await git(['status', '--porcelain'], { cwd: repo, settings, allowFail: true })
  if (status.code === 0) summary.dirty = status.stdout.split('\n').filter(Boolean).length
  const head = await git(['rev-parse', 'HEAD'], { cwd: repo, settings, allowFail: true })
  if (head.code === 0) summary.head = head.stdout.trim()
  const ab = await aheadBehind(repo, settings)
  summary.behind = ab.behind
  summary.ahead = ab.ahead
  summary.diverged = Boolean(ab.ahead > 0 && ab.behind > 0)
  return summary
}

// ─────────────────────────── GitHub API ───────────────────────────

function parseRepoUrl(url) {
  const value = String(url || '').trim()
  let match = /^(?:https?:\/\/)(?:[^/@]+@)?github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i.exec(value)
  if (!match) match = /^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/i.exec(value)
  if (!match) return null
  return { host: 'github.com', owner: match[1], repo: match[2] }
}

async function resolveToken(settings) {
  if (settings && settings.token) return { token: settings.token, source: 'settings' }
  try {
    const token = (await runCommand('gh', ['auth', 'token'], { timeout: 10000 })).trim()
    if (token) return { token, source: 'gh' }
  } catch {
    /* gh недоступен или не залогинен */
  }
  return { token: '', source: null }
}

async function githubRequest(settings, path, init = {}) {
  const { token } = await resolveToken(settings)
  if (!token) throw makeError(401, 'Нет токена GitHub: войдите через gh или укажите PAT в настройках')
  const response = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + token,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-settings-sync',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail = payload && (payload.message || payload.error) ? payload.message || payload.error : 'HTTP ' + response.status
    throw makeError(response.status === 401 ? 401 : 502, 'GitHub: ' + detail)
  }
  return payload
}

async function githubAccountRun() {
  const settings = await loadSettings()
  const resolved = await resolveToken(settings)
  if (!resolved.token) return { connected: false, source: null, login: null, name: null }
  const user = await githubRequest(settings, '/user')
  return { connected: true, source: resolved.source, login: user.login, name: user.name || '', avatar: user.avatar_url || '' }
}

async function githubReposRun(query) {
  const settings = await loadSettings()
  const list = await githubRequest(settings, '/user/repos?per_page=100&sort=updated&affiliation=owner')
  const needle = String(query || '').trim().toLowerCase()
  return (Array.isArray(list) ? list : [])
    .map((repo) => ({
      fullName: repo.full_name,
      name: repo.name,
      private: Boolean(repo.private),
      defaultBranch: repo.default_branch || 'main',
      updatedAt: repo.updated_at,
    }))
    .filter((repo) => !needle || repo.fullName.toLowerCase().includes(needle))
}

async function githubCreateRun(body) {
  const settings = await loadSettings()
  const name = String((body && body.name) || '').trim()
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw makeError(400, 'Имя репозитория: латиница, цифры, точка, дефис, подчёркивание')
  const repo = await githubRequest(settings, '/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name,
      private: true,
      auto_init: false,
      description: 'DSH settings and plugins sync (dsh-settings-sync)',
    }),
  })
  return { fullName: repo.full_name, repoUrl: repo.clone_url, private: Boolean(repo.private), defaultBranch: repo.default_branch || 'main' }
}

async function assertPushAllowed(settings) {
  const parsed = parseRepoUrl(settings.repoUrl)
  if (!parsed) return { checked: false }
  const resolved = await resolveToken(settings)
  if (!resolved.token) return { checked: false }
  const repo = await githubRequest(settings, '/repos/' + parsed.owner + '/' + parsed.repo)
  if (!repo || repo.private !== true) {
    throw makeError(403, 'Репозиторий публичный: синхронизация настроек с токенами разрешена только в приватный репозиторий')
  }
  return { checked: true, private: true }
}

// ─────────────────────────── бэкапы ───────────────────────────

async function listBackups() {
  let entries
  try {
    entries = await fsp.readdir(backupRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()
}

async function backupNow(home, repo, settings) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(backupRoot(), stamp)
  const localPlugins = await collectLocalPlugins(home, await getProfiles(home), settings)
  const entries = await managedEntries(home, settings, localPlugins)
  const files = []
  for (const [rel, abs] of entries) {
    if (rel.startsWith('plugins/')) continue
    const dst = join(dir, 'home', ...rel.split('/'))
    await fsp.mkdir(dirname(dst), { recursive: true })
    await fsp.copyFile(abs, dst)
    files.push(rel)
  }
  await writeJsonAtomic(join(dir, 'manifest.json'), {
    at: new Date().toISOString(),
    host: hostname(),
    dshHome: home,
    files,
  })
  return dir
}

// ─────────────────────────── status ───────────────────────────

async function dshVersion(home) {
  try {
    const runtime = await readJson(dshVersionPath(home))
    if (runtime && typeof runtime.desktopVersion === 'string') return runtime.desktopVersion
  } catch {
    /* ignore */
  }
  return null
}

async function statusRun() {
  const settings = await loadSettings()
  const home = homeRoot()
  const repo = repoPath(settings)
  const repoExists = await exists(join(repo, '.git'))
  const localPlugins = await collectLocalPlugins(home, await getProfiles(home), settings)
  const entries = await managedEntries(home, settings, localPlugins)
  const rels = [...entries.keys()].sort()
  const live = await hashLive(entries)
  const repoMap = repoExists ? await hashRepo(repo) : new Map()

  const modified = []
  const onlyLive = []
  const onlyRepo = []
  let same = 0
  for (const key of new Set([...live.keys(), ...repoMap.keys()])) {
    if (live.has(key) && repoMap.has(key)) {
      if (live.get(key) === repoMap.get(key)) same += 1
      else modified.push(key)
    } else if (live.has(key)) onlyLive.push(key)
    else onlyRepo.push(key)
  }

  const gitState = repoExists
    ? await gitSummary(repo, settings)
    : { branch: null, remote: null, dirty: 0, ahead: null, behind: null, head: null, diverged: false }

  let lastCapture = null
  try {
    lastCapture = await readJson(join(repo, 'meta', 'capture.json'))
  } catch {
    lastCapture = null
  }

  let account = null
  const parsedRepo = parseRepoUrl(settings.repoUrl)
  const resolved = await resolveToken(settings)
  if (parsedRepo && resolved.token) {
    try {
      const user = await githubRequest(settings, '/user')
      account = { login: user.login, name: user.name || '', source: resolved.source }
    } catch {
      account = { login: null, name: '', source: resolved.source, error: 'токен не принят GitHub' }
    }
  }

  return {
    dshHome: home,
    syncDir: syncRoot(),
    repoDir: repo,
    repoExists,
    repoUrl: settings.repoUrl,
    branch: settings.branch,
    profile: settings.profile,
    hasToken: Boolean(settings.token),
    tokenSource: resolved.source,
    github: account,
    categories: { ...settings.categories },
    autoOnStart: settings.autoOnStart,
    autoOnChange: settings.autoOnChange,
    autoPush: settings.autoPush,
    intervalMinutes: settings.intervalMinutes,
    dshVersion: await dshVersion(home),
    nodeVersion: process.version,
    platform: process.platform,
    managed: rels.length,
    localPlugins: localPlugins.map((p) => ({ name: p.name, spec: p.spec, dir: p.dir })),
    diff: { same, modified, onlyLive, onlyRepo },
    git: gitState,
    lastCaptureAt: lastCapture && lastCapture.capturedAt ? lastCapture.capturedAt : null,
    lastCaptureHost: lastCapture && lastCapture.host ? lastCapture.host : null,
    lastCaptureVersion: lastCapture && lastCapture.dshVersion ? lastCapture.dshVersion : null,
    backups: await listBackups(),
    busy: state.busy,
    lastOp: state.lastOp,
  }
}

// ─────────────────────────── действия ───────────────────────────

async function initRun() {
  const settings = await loadSettings()
  const repo = await ensureRepo(settings)
  return { repoDir: repo, repoExists: true }
}

async function captureRun(options = {}) {
  const settings = await loadSettings()
  const home = homeRoot()
  const repo = await ensureRepo(settings)
  if (options.push) {
    if (!settings.repoUrl) throw makeError(400, 'Репозиторий не настроен: укажите URL и сохраните настройки')
    await assertPushAllowed(settings)
  }

  const profiles = await getProfiles(home)
  const localPlugins = await collectLocalPlugins(home, profiles, settings)
  const entries = await managedEntries(home, settings, localPlugins)
  const rels = [...entries.keys()].sort()
  if (!rels.length) throw makeError(400, 'Нет файлов для синхронизации: проверьте, что профиль существует')

  const files = {}
  for (const [rel, abs] of entries) {
    if (rel.startsWith('plugins/')) continue
    await copyLiveToRepo(repo, rel, abs)
    files[rel] = isTextRel(rel) ? hashText(encodePaths(await fsp.readFile(abs, 'utf8'))) : await hashFile(abs)
  }

  const pluginsRoot = join(repo, 'plugins')
  await fsp.rm(pluginsRoot, { recursive: true, force: true })
  for (const plugin of localPlugins) {
    await copyPluginTree(plugin.source, join(pluginsRoot, plugin.dir))
  }
  await writeRepoConfig(repo, localPlugins)

  const previous = await readJson(join(repo, 'meta', 'capture.json')).catch(() => null)
  const previousFiles = previous && previous.files && typeof previous.files === 'object' ? previous.files : {}
  const added = []
  const changed = []
  for (const [rel, hash] of Object.entries(files)) {
    if (!(rel in previousFiles)) added.push(rel)
    else if (String(previousFiles[rel]).toLowerCase() !== hash) changed.push(rel)
  }
  const stale = Object.keys(previousFiles).filter((rel) => !(rel in files))

  const version = await dshVersion(home)
  const contentChanged = added.length > 0 || changed.length > 0 || stale.length > 0
  if (contentChanged || !previous) {
    await writeJsonAtomic(join(repo, 'meta', 'capture.json'), {
      capturedAt: new Date().toISOString(),
      host: hostname(),
      dshHome: home,
      dshVersion: version,
      files,
    })
    if (version) await writeTextAtomic(join(repo, 'meta', 'dsh-version.txt'), version + '\n')
  }

  await git(['add', '-A'], { cwd: repo, settings })
  const status = await git(['status', '--porcelain'], { cwd: repo, settings })
  const dirtyLines = status.stdout.split('\n').filter(Boolean)
  let committed = false
  let commit = null
  if (dirtyLines.length) {
    const message = options.message ? String(options.message) : 'sync: capture ' + hostname() + ' ' + new Date().toISOString()
    await git(['commit', '-m', message], { cwd: repo, settings })
    committed = true
    const head = await git(['rev-parse', 'HEAD'], { cwd: repo, settings, allowFail: true })
    if (head.code === 0) commit = head.stdout.trim()
  }

  let pushed = false
  let pushOutput = ''
  if (options.push) {
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: repo,
      settings,
      allowFail: true,
    })
    const result = upstream.code === 0
      ? await git(['push'], { cwd: repo, settings })
      : await git(['push', '-u', 'origin', 'HEAD'], { cwd: repo, settings })
    pushed = true
    pushOutput = tail(result.stdout + result.stderr, 2000)
  }

  return {
    repoDir: repo,
    files: rels.length,
    localPlugins: localPlugins.length,
    added,
    changed,
    stale,
    committed,
    commit,
    pushed,
    pushOutput,
    gitStatus: dirtyLines.slice(0, 100),
  }
}

async function pullRun() {
  const settings = await loadSettings()
  const repo = await ensureRepo(settings)
  const branch = settings.branch || 'main'
  const hasRemote = Boolean(settings.repoUrl) || (await git(['remote', 'get-url', 'origin'], { cwd: repo, settings, allowFail: true })).stdout.trim()
  if (!hasRemote) throw makeError(400, 'Репозиторий не настроен')

  await fetchRemote(repo, settings)
  const ab = await aheadBehind(repo, settings, branch)
  if (ab.ahead > 0 && ab.behind > 0) {
    throw makeError(
      409,
      'Локальные и удалённые коммиты разошлись. Выберите «Взять удалённое» или «Отправить локальное» в разделе «Расхождение».',
      'diverged',
    )
  }

  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    cwd: repo,
    settings,
    allowFail: true,
  })
  let output = ''
  let updated = false
  if (upstream.code === 0) {
    const result = await git(['pull', '--rebase', '--autostash'], { cwd: repo, settings })
    output = tail(result.stdout + result.stderr, 4000)
    updated = /Updating|Fast-forward|files? changed/i.test(output)
  } else {
    const remoteRef = await git(['rev-parse', '--verify', 'origin/' + branch], { cwd: repo, settings, allowFail: true })
    const head = await git(['rev-parse', '--verify', 'HEAD'], { cwd: repo, settings, allowFail: true })
    if (remoteRef.code !== 0) throw makeError(400, 'В удалённом репозитории нет ветки ' + branch + ': сначала «Захватить и отправить» на первой машине')
    if (head.code !== 0) {
      await git(['reset', '--hard', 'origin/' + branch], { cwd: repo, settings })
      await git(['branch', '--set-upstream-to=origin/' + branch], { cwd: repo, settings, allowFail: true })
    } else {
      const result = await git(['pull', '--rebase', '--autostash', 'origin', branch], { cwd: repo, settings })
      output = tail(result.stdout + result.stderr, 4000)
    }
    updated = true
  }
  return { repoDir: repo, output, updated, ahead: ab.ahead, behind: ab.behind }
}

async function resolveRun(options = {}) {
  const settings = await loadSettings()
  const repo = await ensureRepo(settings)
  const branch = settings.branch || 'main'
  const strategy = String(options.strategy || '')
  if (strategy === 'remote') {
    await backupNow(homeRoot(), repo, settings)
    await fetchRemote(repo, settings)
    await git(['reset', '--hard', 'origin/' + branch], { cwd: repo, settings })
    return { strategy, output: 'Локальная копия репозитория сброшена на origin/' + branch + '. Теперь нажмите «Применить».' }
  }
  if (strategy === 'local') {
    const result = await git(['push', '--force-with-lease', 'origin', 'HEAD:' + branch], { cwd: repo, settings })
    return { strategy, output: tail(result.stdout + result.stderr, 2000) }
  }
  throw makeError(400, 'Неизвестная стратегия разрешения расхождения')
}

async function historyRun() {
  const settings = await loadSettings()
  const repo = repoPath(settings)
  if (!(await exists(join(repo, '.git')))) return { commits: [] }
  const result = await git(['log', '--max-count=30', '--pretty=format:%H%x09%cI%x09%s'], { cwd: repo, settings, allowFail: true })
  if (result.code !== 0) return { commits: [] }
  return {
    commits: result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, date, ...rest] = line.split('\t')
        return { sha, date, subject: rest.join('\t') }
      }),
  }
}

async function restoreCommitRun(options = {}) {
  const settings = await loadSettings()
  const repo = await ensureRepo(settings)
  const sha = String(options.sha || '').trim()
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw makeError(400, 'Нужен SHA коммита')
  const existsCommit = await git(['cat-file', '-e', sha + '^{commit}'], { cwd: repo, settings, allowFail: true })
  if (existsCommit.code !== 0) throw makeError(404, 'Коммит не найден в локальной копии: сначала «Получить»')
  await backupNow(homeRoot(), repo, settings)
  await git(['reset', '--hard', sha], { cwd: repo, settings })
  return { restored: sha, output: 'Репозиторий переключён на ' + sha.slice(0, 10) + '. Нажмите «Применить».', backupDir: null }
}

async function installDeps(home) {
  const depsDir = join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies')
  const nodeCandidates = [
    join(depsDir, 'node', 'bin', 'node'),
    join(depsDir, 'node', 'bin', 'node.exe'),
    'node',
  ]
  const pnpmCandidates = [
    join(depsDir, 'pnpm', 'bin', 'pnpm.cjs'),
    join(depsDir, 'pnpm', 'bin', 'pnpm'),
  ]
  const node = nodeCandidates.find((candidate) => existsSync(candidate)) || 'node'
  const pnpm = pnpmCandidates.find((candidate) => existsSync(candidate))
  const profiles = await getProfiles(home)
  const lines = []
  for (const profile of profiles) {
    const dir = join(home, 'profiles', profile)
    if (!(await exists(join(dir, 'pnpm-lock.yaml')))) {
      lines.push('[' + profile + '] нет pnpm-lock.yaml, пропуск')
      continue
    }
    const args = pnpm ? [pnpm, 'install', '--frozen-lockfile'] : ['install', '--frozen-lockfile']
    const stdout = await new Promise((resolvePromise, rejectPromise) => {
      execFile(
        node,
        args,
        { cwd: dir, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: process.env },
        (error, out, err) => {
          if (error) {
            rejectPromise(new Error('[' + profile + '] pnpm install не удался: ' + tail(String(err || '') || error.message, 600)))
            return
          }
          resolvePromise(String(out || ''))
        },
      )
    })
    lines.push('[' + profile + '] ok')
    if (stdout.trim()) lines.push(tail(stdout, 1200))
  }
  return lines.join('\n')
}

/**
 * На чужой машине link:/абсолютный/путь из package.json может отсутствовать.
 * Возвращаем исходники по записанному пути: сначала симлинком на локальную
 * распаковку, при неудаче — копией, и только в крайнем случае переписываем
 * зависимость на settings-sync/extensions.
 */
async function restoreLocalPluginPaths(home, repo, plugins) {
  const restored = []
  if (!plugins.length) return restored
  const profiles = await getProfiles(home)
  for (const profile of profiles) {
    const file = join(home, 'profiles', profile, 'package.json')
    if (!(await exists(file))) continue
    let pkg
    try {
      pkg = await readJson(file)
    } catch {
      continue
    }
    const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : null
    if (!deps) continue
    let pkgChanged = false
    for (const plugin of plugins) {
      if (!(plugin.name in deps)) continue
      const parsed = specPath(deps[plugin.name])
      if (!parsed) continue
      const target = isAbsolute(parsed.raw) ? parsed.raw : resolve(join(home, 'profiles', profile), parsed.raw)
      if (existsSync(target)) continue
      const localPath = join(extensionsRoot(), plugin.dir)
      if (!(await exists(localPath))) continue
      try {
        await fsp.mkdir(dirname(target), { recursive: true })
        try {
          await fsp.symlink(localPath, target, 'dir')
          restored.push({ name: plugin.name, target, mode: 'symlink' })
        } catch {
          await copyPluginTree(localPath, target)
          restored.push({ name: plugin.name, target, mode: 'copy' })
        }
      } catch (error) {
        deps[plugin.name] = (parsed.kind === 'file' ? 'file:' : 'link:') + localPath
        pkgChanged = true
        restored.push({ name: plugin.name, target: localPath, mode: 'rewritten', error: String((error && error.message) || error) })
      }
    }
    if (pkgChanged) await writeJsonAtomic(file, pkg)
  }
  return restored
}

async function extractLocalPlugins(home, repo, plugins) {
  const extracted = []
  if (!plugins.length) return extracted
  const root = extensionsRoot()
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  for (const plugin of plugins) {
    const src = join(repo, 'plugins', plugin.dir)
    if (!(await exists(src))) continue
    const dst = join(root, plugin.dir)
    await fsp.rm(dst, { recursive: true, force: true })
    await copyPluginTree(src, dst)
    extracted.push(plugin.name)
  }
  return extracted
}

async function applyRun(options = {}) {
  const settings = await loadSettings()
  const home = homeRoot()
  const repo = repoPath(settings)
  const repoHome = join(repo, 'home')
  if (!(await exists(repoHome))) {
    throw makeError(400, 'В репозитории нет home/: сначала «Захватить и отправить» на первой машине или «Получить»')
  }

  const cfg = await readRepoConfig(repo)
  const backupDir = await backupNow(home, repo, settings)
  const files = await walkFiles(repoHome)
  let applied = 0
  for (const rel of files) {
    if (shouldSkip(rel)) continue
    await copyRepoToLive(home, repo, rel)
    applied += 1
  }

  const extracted = await extractLocalPlugins(home, repo, cfg.localPlugins)
  const restored = await restoreLocalPluginPaths(home, repo, cfg.localPlugins)

  let installOutput = ''
  if (options.install !== false) {
    try {
      installOutput = await installDeps(home)
    } catch (error) {
      installOutput = String((error && error.message) || error)
    }
  }

  return {
    applied,
    backupDir,
    localPlugins: extracted,
    restored,
    installOutput,
    restartRequired: true,
  }
}

async function restoreRun(options = {}) {
  const home = homeRoot()
  const backups = await listBackups()
  if (!backups.length) throw makeError(400, 'Нет доступных бэкапов')
  const name = options.name ? String(options.name) : backups[0]
  const dir = join(backupRoot(), name)
  const srcHome = join(dir, 'home')
  if (!(await exists(srcHome))) throw makeError(400, 'Бэкап неполный (нет home/): ' + name)
  const files = await walkFiles(srcHome)
  let restored = 0
  for (const rel of files) {
    const src = join(srcHome, ...rel.split('/'))
    const dst = join(home, ...rel.split('/'))
    await fsp.mkdir(dirname(dst), { recursive: true })
    await fsp.copyFile(src, dst)
    restored += 1
  }
  return { restored, backup: name, backups }
}

async function scanRun() {
  const settings = await loadSettings()
  const repo = repoPath(settings)
  const root = join(repo, 'home')
  if (!(await exists(root))) throw makeError(400, 'В репозитории нет home/: сначала «Захватить»')
  const hits = []
  const files = [...(await walkFiles(root)).map((rel) => ({ rel, abs: join(root, ...rel.split('/')) }))]
  const pluginsRoot = join(repo, 'plugins')
  if (await exists(pluginsRoot)) {
    for (const rel of await walkFiles(pluginsRoot)) {
      files.push({ rel: 'plugins/' + rel, abs: join(pluginsRoot, ...rel.split('/')) })
    }
  }
  for (const { rel, abs } of files) {
    if (shouldSkip(rel)) continue
    let text
    try {
      text = await fsp.readFile(abs, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      for (const pattern of SECRET_PATTERNS) {
        pattern.re.lastIndex = 0
        if (pattern.re.test(lines[i])) {
          hits.push({ file: rel, line: i + 1, pattern: pattern.name, text: lines[i].trim().slice(0, 160) })
          if (hits.length >= 200) return { hits, truncated: true }
        }
      }
    }
  }
  return { hits, truncated: false }
}

async function syncRun() {
  const settings = await loadSettings()
  if (!settings.repoUrl) throw makeError(400, 'Репозиторий не настроен')
  // Сначала фиксируем локальное состояние, чтобы pull не потерял правки,
  // затем забираем удалённое и применяем только если оно изменилось.
  const captured = await captureRun({ push: false })
  const pulled = await pullRun()
  let applied = null
  if (pulled.updated) applied = await applyRun({ install: true })
  else applied = { applied: 0, localPlugins: [], restored: [], installOutput: '', restartRequired: false }
  const pushed = await captureRun({ push: true })
  return { captured, pulled, applied, pushed }
}

// ─────────────────────────── HTTP ───────────────────────────

function isLoopback(req) {
  const address = (req.socket && req.socket.remoteAddress) || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(makeError(413, 'Тело запроса слишком большое'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolvePromise({})
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        rejectPromise(makeError(400, 'Тело запроса — не JSON'))
      }
    })
    req.on('error', rejectPromise)
  })
}

async function runOp(kind, fn) {
  if (state.busy) throw makeError(409, 'Уже выполняется другая операция синхронизации')
  state.busy = true
  const startedAt = Date.now()
  try {
    const data = await fn()
    state.lastOp = { kind, ok: true, at: new Date().toISOString(), ms: Date.now() - startedAt }
    return data
  } catch (error) {
    state.lastOp = {
      kind,
      ok: false,
      at: new Date().toISOString(),
      ms: Date.now() - startedAt,
      error: String(error && error.message),
    }
    throw error
  } finally {
    state.busy = false
  }
}

function makeRoute(path, handler) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'Разрешено только локальное подключение' })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        sendJson(res, (error && error.statusCode) || 500, {
          ok: false,
          error: String((error && error.message) || error),
          code: error && error.code,
        })
      }
    },
  }
}

function methodNotAllowed(res) {
  sendJson(res, 405, { ok: false, error: 'метод не поддерживается' })
}

function buildRoutes() {
  return [
    makeRoute(API + '/status', async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res)
      sendJson(res, 200, { ok: true, data: await statusRun() })
    }),
    makeRoute(API + '/settings', async (req, res) => {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, data: publicSettings(await loadSettings()) })
      if (req.method === 'PUT' || req.method === 'POST') {
        return sendJson(res, 200, { ok: true, data: publicSettings(await saveSettings(await readBody(req))) })
      }
      methodNotAllowed(res)
    }),
    makeRoute(API + '/github/account', async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res)
      sendJson(res, 200, { ok: true, data: await githubAccountRun() })
    }),
    makeRoute(API + '/github/repos', async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res)
      const url = new URL(req.url, 'http://localhost')
      sendJson(res, 200, { ok: true, data: { repos: await githubReposRun(url.searchParams.get('q') || '') } })
    }),
    makeRoute(API + '/github/create', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      sendJson(res, 200, { ok: true, data: await githubCreateRun(await readBody(req)) })
    }),
    makeRoute(API + '/init', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      sendJson(res, 200, { ok: true, data: await runOp('init', () => initRun()) })
    }),
    makeRoute(API + '/capture', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      const body = await readBody(req)
      sendJson(res, 200, { ok: true, data: await runOp('capture', () => captureRun({ push: Boolean(body.push), message: body.message })) })
    }),
    makeRoute(API + '/pull', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      sendJson(res, 200, { ok: true, data: await runOp('pull', () => pullRun()) })
    }),
    makeRoute(API + '/apply', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      const body = await readBody(req)
      sendJson(res, 200, { ok: true, data: await runOp('apply', () => applyRun({ install: body.install !== false })) })
    }),
    makeRoute(API + '/sync', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      sendJson(res, 200, { ok: true, data: await runOp('sync', () => syncRun()) })
    }),
    makeRoute(API + '/resolve', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      const body = await readBody(req)
      sendJson(res, 200, { ok: true, data: await runOp('resolve', () => resolveRun({ strategy: body.strategy })) })
    }),
    makeRoute(API + '/restore', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      const body = await readBody(req)
      sendJson(res, 200, { ok: true, data: await runOp('restore', () => restoreRun({ name: body.name })) })
    }),
    makeRoute(API + '/history', async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res)
      sendJson(res, 200, { ok: true, data: await historyRun() })
    }),
    makeRoute(API + '/restore-commit', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      const body = await readBody(req)
      sendJson(res, 200, { ok: true, data: await runOp('restore-commit', () => restoreCommitRun({ sha: body.sha })) })
    }),
    makeRoute(API + '/scan', async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      sendJson(res, 200, { ok: true, data: await runOp('scan', () => scanRun()) })
    }),
    makeRoute(API + '/backups', async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res)
      sendJson(res, 200, { ok: true, data: { backups: await listBackups() } })
    }),
  ]
}

// ─────────────────────────── авто-синхронизация ───────────────────────────

async function autoStart(ctx) {
  const settings = await loadSettings()
  if (!settings.autoOnStart || !settings.repoUrl) return
  try {
    const pulled = await runOp('auto-start-pull', () => pullRun())
    if (pulled.updated) {
      await runOp('auto-start-apply', () => applyRun({ install: false }))
      ctx.logger.info('[settings-sync] авто-старт: удалённые изменения применены, нужен перезапуск')
    }
  } catch (error) {
    ctx.logger.warn('[settings-sync] авто-старт не удался: ' + ((error && error.message) || error))
  }
}

async function autoTick(ctx) {
  if (state.busy) return
  const settings = await loadSettings()
  if (!settings.autoOnChange || !settings.repoUrl) return
  const now = Date.now()
  const interval = Math.max(2, settings.intervalMinutes || 10) * 60 * 1000
  if (now - state.lastAutoAt < interval) return
  state.lastAutoAt = now
  try {
    const status = await statusRun()
    if (!status.diff.modified.length && !status.diff.onlyLive.length) return
    if (now - state.lastAutoChangeAt < (settings.debounceMs || 6000)) return
    state.lastAutoChangeAt = now
    const result = await runOp('auto-capture', () => captureRun({ push: settings.autoPush }))
    if (result.committed) {
      ctx.logger.info('[settings-sync] авто-захват: ' + result.files + ' файлов, push=' + result.pushed)
    }
  } catch (error) {
    try {
      ctx.logger.warn('[settings-sync] авто-захват не удался: ' + ((error && error.message) || error))
    } catch {
      /* ignore */
    }
  }
}

// ─────────────────────────── tool / command ───────────────────────────

async function toolText(action, args) {
  if (action === 'status') {
    const s = await statusRun()
    return [
      'Репозиторий: ' + (s.repoUrl || 'не настроен') + ' (' + s.branch + ')',
      'Синхронизация: ' + s.dshHome + ' -> ' + s.repoDir,
      'GitHub: ' + (s.github && s.github.login ? s.github.login + ' (' + s.github.source + ')' : 'не подключён'),
      'Файлов: ' + s.managed + ' · совпадает ' + s.diff.same + ' · изменено ' + s.diff.modified.length + ' · только локально ' + s.diff.onlyLive.length + ' · только в репозитории ' + s.diff.onlyRepo.length,
      'Локальные плагины: ' + (s.localPlugins.length ? s.localPlugins.map((p) => p.name).join(', ') : 'нет'),
      'Git: ahead/behind ' + String(s.git.ahead) + '/' + String(s.git.behind) + (s.git.diverged ? ' · РАСХОЖДЕНИЕ' : ''),
      'Последний захват: ' + (s.lastCaptureAt || 'нет'),
      'Последняя операция: ' + (s.lastOp ? s.lastOp.kind + (s.lastOp.ok ? ' ok' : ' fail: ' + s.lastOp.error) : 'нет'),
    ].join('\n')
  }
  if (action === 'push') {
    const r = await runOp('push', () => captureRun({ push: true, message: args.message }))
    return 'Добавлено: ' + r.added.length + ', изменено: ' + r.changed.length + ', коммит: ' + (r.commit || 'нет') + ', push=' + r.pushed + (r.pushOutput ? '\n' + r.pushOutput : '')
  }
  if (action === 'pull') {
    const r = await runOp('pull', () => pullRun())
    return r.output || ('Обновлено: ' + (r.updated ? 'да' : 'нет'))
  }
  if (action === 'apply') {
    const r = await runOp('apply', () => applyRun({ install: true }))
    return 'Записано файлов: ' + r.applied + '\nЛокальные плагины: ' + (r.localPlugins.join(', ') || 'нет') + '\n' + r.installOutput + '\nНужен перезапуск DSH.'
  }
  if (action === 'sync') {
    const r = await runOp('sync', () => syncRun())
    return 'Синхронизировано. Применено файлов: ' + r.applied.applied + ', коммит: ' + (r.captured.commit || 'нет') + '. Нужен перезапуск DSH.'
  }
  if (action === 'history') {
    const r = await historyRun()
    return r.commits.slice(0, 15).map((c) => c.sha.slice(0, 10) + '  ' + c.date + '  ' + c.subject).join('\n') || 'История пуста'
  }
  if (action === 'restore') {
    if (!args.confirm) throw makeError(400, 'Для восстановления нужен confirm: true')
    const r = await runOp('restore', () => (args.sha ? restoreCommitRun({ sha: args.sha }) : restoreRun({ name: args.name })))
    return JSON.stringify(r)
  }
  if (action === 'scan') {
    const r = await scanRun()
    return r.hits.length
      ? r.hits.map((h) => '[' + h.pattern + '] ' + h.file + ':' + h.line + '  ' + h.text).join('\n')
      : 'Секретов не найдено'
  }
  throw makeError(400, 'Неизвестное действие: ' + action)
}

function registerCommand(ctx, log) {
  const commands = ctx.get ? ctx.get('commands') : undefined
  if (!commands || typeof commands.register !== 'function') return
  try {
    commands.register({
      name: 'sync',
      description: 'Синхронизация настроек и плагинов DSH через GitHub: status, push, pull, apply, sync, history, scan.',
      input: { hint: 'status | push | pull | apply | sync | history | scan' },
      handler: async (invocation) => {
        const raw = String((invocation && invocation.rawInput) || '').trim()
        const [action = 'status', ...rest] = raw.split(/\s+/)
        try {
          if (action === 'help') return { kind: 'success', text: 'Команды: status, push, pull, apply, sync, history, scan' }
          const text = await toolText(action, { message: rest.join(' ') || undefined })
          return { kind: 'success', text }
        } catch (error) {
          log.warn('[settings-sync] /sync: ' + ((error && error.message) || error))
          return { kind: 'error', text: String((error && error.message) || error) }
        }
      },
    })
  } catch (error) {
    log.warn('[settings-sync] команда /sync не зарегистрирована: ' + ((error && error.message) || error))
  }
}

async function registerTool(ctx, log) {
  const tools = ctx.get ? ctx.get('tools') : undefined
  const loader = ctx.get ? ctx.get('loader') : undefined
  if (!tools || !loader || typeof loader.import !== 'function') return
  try {
    const { defineTool } = await loader.import('@deepseek-ai/dsh-tools')
    if (!defineTool || ctx.fiber.uid === null) return
    tools.register(
      defineTool({
        name: 'settings_sync',
        description:
          'Sync DSH settings and installed plugins through a private GitHub repository (like VS Code Settings Sync): status, push, pull, apply, history, scan. Apply rewrites live profile files after a backup and requires a DSH restart.',
        parameters: {
          action: {
            type: 'string',
            required: true,
            enum: ['status', 'push', 'pull', 'apply', 'sync', 'history', 'restore', 'scan'],
            description: 'status — state; push — capture+push; pull — fetch remote; apply — write remote snapshot locally; sync — pull+apply+push; history — commits; restore — backup or commit (needs confirm); scan — secret report.',
          },
          message: { type: 'string', description: 'Commit message for push (optional).' },
          sha: { type: 'string', description: 'Commit SHA for restore (optional).' },
          name: { type: 'string', description: 'Backup name for restore (optional).' },
          confirm: { type: 'boolean', description: 'Required true for restore.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string', required: true } },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args) {
          try {
            const text = await toolText(String(args.action), args)
            return { text }
          } catch (error) {
            return { text: 'Ошибка: ' + String((error && error.message) || error) }
          }
        },
      }),
    )
  } catch (error) {
    log.warn('[settings-sync] инструмент settings_sync не зарегистрирован: ' + ((error && error.message) || error))
  }
}

// ─────────────────────────── вход плагина ───────────────────────────

export function apply(ctx) {
  const log = ctx.logger
  const routes = buildRoutes()
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
  }, 'settings-sync: http routes')

  ctx.effect(() => {
    const timer = setInterval(() => {
      autoTick(ctx).catch(() => {})
    }, AUTO_TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'settings-sync: auto change')

  ctx.effect(() => {
    const timer = setTimeout(() => {
      autoStart(ctx).catch(() => {})
    }, 5000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }, 'settings-sync: auto start')

  registerCommand(ctx, log)
  void registerTool(ctx, log)

  try {
    log.info('[settings-sync] ready · DSH_HOME=' + homeRoot())
  } catch {
    /* ignore */
  }
}

/** Внутренние функции для тестов и диагностики. */
export const __internals = {
  homeRoot,
  syncRoot,
  repoPath,
  backupRoot,
  extensionsRoot,
  loadSettings,
  saveSettings,
  publicSettings,
  readRepoConfig,
  managedEntries,
  managedRels,
  collectLocalPlugins,
  encodePaths,
  decodePaths,
  statusRun,
  initRun,
  captureRun,
  pullRun,
  applyRun,
  restoreRun,
  scanRun,
  listBackups,
  dshVersion,
  buildRoutes,
  githubAccountRun,
  githubReposRun,
  githubCreateRun,
  parseRepoUrl,
  resolveRun,
  historyRun,
  state,
}
