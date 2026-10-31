import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exec, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const { DatabaseSync } = await import('node:sqlite').catch(() => {
  console.error(`需要 Node.js 22.5 或更高版本，当前是 ${process.versions.node}`)
  process.exit(1)
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKUP_DIR = path.join(__dirname, 'backups')
const PUBLIC_DIR = path.join(__dirname, 'public')
const PORT_START = Number(process.env.PORT) || 5199
const PROJECT_COLORS = ['#d6a312', '#d6409f', '#12a594', '#f76b15', '#8e4ec6', '#e5484d', '#30a46c', '#0091ff', '#f5a623', '#46a758']

function opencodeDbFromCli() {
  const commands = process.platform === 'win32' ? ['opencode.exe', 'opencode'] : ['opencode']
  for (const command of commands) {
    try {
      const result = spawnSync(command, ['db', 'path'], { encoding: 'utf8', timeout: 2500, windowsHide: true })
      if (result.status !== 0 || !result.stdout) continue
      const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
      if (line && fs.existsSync(line)) return line
    } catch {}
  }
  return null
}

function resolveDbPath() {
  const envDb = process.env.OPENCODE_DB
  if (envDb) {
    const candidate = path.isAbsolute(envDb) ? envDb : path.resolve(envDb)
    if (fs.existsSync(candidate)) return candidate
  }
  const cliDb = opencodeDbFromCli()
  if (cliDb) return cliDb
  const dataDirs = [
    process.env.OPENCODE_DATA_DIR,
    process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, 'opencode'),
    path.join(os.homedir(), '.local', 'share', 'opencode'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'opencode'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'opencode'),
  ].filter(Boolean)
  for (const dir of [...dataDirs, ...dataDirs.map((item) => path.join(item, 'data'))]) {
    const candidate = path.join(dir, 'opencode.db')
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('找不到 opencode.db，可用 OPENCODE_DB 或 OPENCODE_DATA_DIR 指定')
}

function resolveSettingsPath() {
  const candidates = [
    process.env.OPENCHAMBER_DATA_DIR && path.join(process.env.OPENCHAMBER_DATA_DIR, 'settings.json'),
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, 'openchamber', 'settings.json'),
    path.join(os.homedir(), '.config', 'openchamber', 'settings.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'openchamber', 'settings.json'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'openchamber', 'settings.json'),
  ].filter(Boolean)
  return candidates.find((file) => fs.existsSync(file)) || candidates[0] || ''
}

const DB_PATH = resolveDbPath()
const OPENCODE_DIR = path.dirname(DB_PATH)
const LEGACY_STORAGE_DIR = path.join(OPENCODE_DIR, 'storage')
const SETTINGS_PATH = resolveSettingsPath()

function resolveDesktopSettings() {
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const appData = process.env.APPDATA
  const variants = ['ai.opencode.desktop', 'ai.opencode.desktop.beta', 'ai.opencode.desktop.dev']
  const baseDirs = appData
    ? variants.map((name) => path.join(appData, name))
    : [
        ...variants.map((name) => path.join(os.homedir(), 'Library', 'Application Support', name)),
        ...variants.map((name) => path.join(configRoot, name)),
      ]
  const candidates = baseDirs.map((dir) => path.join(dir, 'opencode.settings'))
  const found = candidates.find((file) => fs.existsSync(file))
  return { path: found || candidates[0], exists: Boolean(found) }
}

function openDb(readOnly = true) {
  const db = new DatabaseSync(DB_PATH, { readOnly })
  db.exec('pragma busy_timeout = 8000')
  if (!readOnly) db.exec('pragma foreign_keys = ON')
  return db
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {
    return null
  }
}

function normalizeDir(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function projectIdFor(dir) {
  return `path_${Buffer.from(String(dir).replace(/\\/g, '/')).toString('base64')}`
}

function windowsPath(dir) {
  return String(dir).replace(/\//g, '\\')
}

function pickColor(projects) {
  const used = new Set(projects.map((p) => p.color))
  return PROJECT_COLORS.find((color) => !used.has(color)) || PROJECT_COLORS[projects.length % PROJECT_COLORS.length]
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function walkSize(dir) {
  const out = { files: 0, bytes: 0 }
  const visit = (current) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) {
        out.files += 1
        try {
          out.bytes += fs.statSync(full).size
        } catch {}
      }
    }
  }
  visit(dir)
  return out
}

function sessionStats(db, projectId) {
  const row = db
    .prepare(
      `select
         (select count(*) from session_v2 where project_id = ?1) as sessions,
         (select count(*) from session_v2 where project_id = ?1 and time_archived is not null) as archived,
         (select count(*) from session_message where session_id in (select id from session_v2 where project_id = ?1)) as messages,
         (select count(*) from session where project_id = ?1) as legacy_sessions`,
    )
    .get(projectId)
  return {
    sessions: Number(row.sessions),
    archived: Number(row.archived),
    messages: Number(row.messages),
    legacySessions: Number(row.legacy_sessions),
  }
}

function listBackups() {
  if (!dirExists(BACKUP_DIR)) return []
  const items = []
  for (const entry of fs.readdirSync(BACKUP_DIR, { withFileTypes: true })) {
    const full = path.join(BACKUP_DIR, entry.name)
    try {
      const stat = fs.statSync(full)
      if (entry.isDirectory()) {
        const size = walkSize(full)
        items.push({ name: entry.name, kind: 'legacy-storage', createdAt: stat.mtimeMs, files: size.files, bytes: size.bytes, targets: [LEGACY_STORAGE_DIR] })
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      let data = null
      try {
        data = JSON.parse(fs.readFileSync(full, 'utf8'))
      } catch {}
      const action = data?.action || 'unknown'
      const restorable = ['delete-projects', 'delete-sessions', 'delete-orphans'].includes(action)
      let targets = []
      if (action === 'delete-projects' || action === 'restore-sessions' || action === 'delete-sessions') {
        targets = (data?.projects || []).map((p) => p.worktree)
        if (targets.length === 0) targets = (data?.sessions || []).map((s) => s.title || s.directory).filter(Boolean)
      } else if (action === 'delete-orphans') {
        targets = (data?.entries || []).map((e) => e.directory).filter(Boolean)
      } else if (action === 'legacy-storage') {
        targets = [LEGACY_STORAGE_DIR]
      } else if (action === 'settings-before-reopen') {
        targets = ['OpenChamber 项目设置']
      }
      items.push({
        name: entry.name,
        kind: action,
        createdAt: data?.createdAt ? Date.parse(data.createdAt) : stat.mtimeMs,
        bytes: stat.size,
        projects: data?.projects?.length || 0,
        sessions: data?.sessions?.length || 0,
        messages: data?.messages?.length || 0,
        entries: data?.entries?.length || 0,
        restorable,
        targets,
      })
    } catch {}
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

function snapshot() {
  const settings = readSettings()
  const desktopSettings = resolveDesktopSettings()
  const openProjects = Array.isArray(settings?.projects) ? settings.projects : []
  const openPaths = new Set(openProjects.map((p) => normalizeDir(p.path)))

  const db = openDb(true)
  const allProjects = db.prepare('select id, worktree, time_created, time_active from project').all()
  const closedProjects = []
  const emptyProjects = []

  for (const project of allProjects) {
    const isOpen = openPaths.has(normalizeDir(project.worktree))
    const stats = sessionStats(db, project.id)
    const item = {
      id: project.id,
      worktree: project.worktree,
      createdAt: project.time_created,
      activeAt: project.time_active,
      dirExists: dirExists(project.worktree),
      ...stats,
    }
    if (!isOpen) {
      if (stats.sessions === 0 && stats.legacySessions === 0) emptyProjects.push(item)
      else closedProjects.push(item)
    }
  }

  const projectById = new Map(allProjects.map((p) => [p.id, p]))
  const orphanEntries = []
  for (const table of ['project_directory', 'worktree']) {
    for (const row of db.prepare(`select project_id, directory from ${table}`).all()) {
      const project = projectById.get(row.project_id)
      if (!project) continue
      if (!dirExists(row.directory)) {
        orphanEntries.push({ table, projectId: row.project_id, worktree: project.worktree, directory: row.directory })
      }
    }
  }

  const archivedSessions = db
    .prepare(
      `select s.id, s.project_id, s.title, s.directory, s.time_created, s.time_archived,
              (select count(*) from session_message where session_id = s.id) as messages
       from session_v2 s
       where s.time_archived is not null
       order by s.time_archived desc`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      project: projectById.get(row.project_id)?.worktree || null,
      title: row.title || '(无标题)',
      directory: row.directory,
      createdAt: row.time_created,
      archivedAt: row.time_archived,
      messages: Number(row.messages),
    }))

  db.close()

  const legacy = dirExists(LEGACY_STORAGE_DIR)
    ? { path: LEGACY_STORAGE_DIR, ...walkSize(LEGACY_STORAGE_DIR) }
    : null

  return {
    paths: { opencode: OPENCODE_DIR, db: DB_PATH, settings: SETTINGS_PATH, legacyStorage: LEGACY_STORAGE_DIR, desktopSettings: desktopSettings.path },
    desktopSettingsFound: desktopSettings.exists,
    settingsFound: Boolean(settings),
    openProjects: openProjects.map((p) => ({ id: p.id, path: p.path, label: p.label })),
    closedProjects,
    emptyProjects,
    orphanEntries,
    archivedSessions,
    legacyStorage: legacy,
    backups: listBackups(),
  }
}

const RESTORE_ORDER = [
  ['projects', 'project'],
  ['project_directory', 'project_directory'],
  ['worktrees', 'worktree'],
  ['permissions', 'permission'],
  ['legacySessions', 'session'],
  ['sessions', 'session_v2'],
  ['messages', 'session_message'],
  ['inbox', 'session_inbox'],
  ['todos', 'todo'],
  ['shares', 'session_share'],
  ['blobRefs', 'blob_ref'],
  ['instructionEntries', 'instruction_entry'],
  ['instructionStates', 'instruction_state'],
  ['legacyMessages', 'message'],
  ['legacyParts', 'part'],
]

function placeholders(ids) {
  return ids.map(() => '?').join(',')
}

function collectSessionData(db, ids) {
  if (ids.length === 0) return {}
  const ph = placeholders(ids)
  const query = (table, column = 'session_id') => db.prepare(`select * from ${table} where ${column} in (${ph})`).all(...ids)
  return {
    sessions: db.prepare(`select * from session_v2 where id in (${ph})`).all(...ids),
    legacySessions: db.prepare(`select * from session where id in (${ph})`).all(...ids),
    messages: query('session_message'),
    inbox: query('session_inbox'),
    todos: query('todo'),
    shares: query('session_share'),
    blobRefs: query('blob_ref'),
    instructionEntries: query('instruction_entry'),
    instructionStates: query('instruction_state'),
    legacyMessages: query('message'),
    legacyParts: query('part'),
  }
}

function collectProjectData(db, ids) {
  if (ids.length === 0) return {}
  const ph = placeholders(ids)
  const sessionIds = db.prepare(`select id from session_v2 where project_id in (${ph})`).all(...ids).map((r) => r.id)
  const legacyIds = db.prepare(`select id from session where project_id in (${ph})`).all(...ids).map((r) => r.id)
  return {
    projects: db.prepare(`select * from project where id in (${ph})`).all(...ids),
    project_directory: db.prepare(`select * from project_directory where project_id in (${ph})`).all(...ids),
    worktrees: db.prepare(`select * from worktree where project_id in (${ph})`).all(...ids),
    permissions: db.prepare(`select * from permission where project_id in (${ph})`).all(...ids),
    ...collectSessionData(db, [...new Set([...sessionIds, ...legacyIds])]),
  }
}

function beginBackup(action, ids, payload) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(BACKUP_DIR, `${stamp}-${action}.json`)
  fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), action, ids, ...payload }, null, 2))
  return file
}

function insertRows(db, table, rows) {
  let count = 0
  for (const row of rows) {
    const columns = Object.keys(row)
    if (columns.length === 0) continue
    const sql = `insert or replace into ${table} (${columns.map((c) => `"${c}"`).join(',')}) values (${columns.map(() => '?').join(',')})`
    count += db.prepare(sql).run(...columns.map((c) => row[c])).changes
  }
  return count
}

function writeTransaction(fn) {
  const db = openDb(false)
  db.exec('begin')
  try {
    const result = fn(db)
    db.exec('commit')
    return result
  } catch (error) {
    db.exec('rollback')
    throw error
  } finally {
    db.close()
  }
}

async function persistProjects(projects) {
  const current = readSettings() || {}
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = path.join(BACKUP_DIR, `${stamp}-settings-before-reopen.json`)
  fs.writeFileSync(backup, JSON.stringify(current, null, 2))

  const port = Number(current.desktopLocalPort) || 57123
  const token = typeof current.desktopLocalClientToken === 'string' ? current.desktopLocalClientToken : ''
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/config/settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ projects }),
      signal: AbortSignal.timeout(2500),
    })
    if (response.ok) return { live: true, backup }
  } catch {}

  const temp = `${SETTINGS_PATH}.cleanup-tmp`
  if (!SETTINGS_PATH) throw new Error('找不到 OpenChamber 设置文件，无法重开项目')
  fs.writeFileSync(temp, JSON.stringify({ ...current, projects }, null, 2))
  fs.renameSync(temp, SETTINGS_PATH)
  return { live: false, backup }
}

const actions = {
  deleteProjects(ids) {
    const db = openDb(true)
    const payload = collectProjectData(db, ids)
    db.close()
    const backup = beginBackup('delete-projects', ids, payload)
    const deleted = writeTransaction((writer) => {
      let count = 0
      for (const id of ids) count += writer.prepare('delete from project where id = ?').run(id).changes
      return count
    })
    return { deleted, backup }
  },

  deleteSessions(ids) {
    const db = openDb(true)
    const payload = collectSessionData(db, ids)
    db.close()
    const backup = beginBackup('delete-sessions', ids, payload)
    const deleted = writeTransaction((writer) => {
      let count = 0
      for (const id of ids) count += writer.prepare('delete from session_v2 where id = ?').run(id).changes
      return count
    })
    return { deleted, backup }
  },

  restoreSessions(ids) {
    const db = openDb(true)
    const payload = collectSessionData(db, ids)
    db.close()
    const backup = beginBackup('restore-sessions', ids, payload)
    const restored = writeTransaction((writer) => {
      let count = 0
      for (const id of ids) {
        count += writer
          .prepare('update session_v2 set time_archived = null, time_updated = ? where id = ?')
          .run(Date.now(), id).changes
      }
      return count
    })
    return { restored, backup }
  },

  deleteOrphanEntries(entries) {
    const db = openDb(true)
    const rows = []
    for (const entry of entries) {
      if (entry.table !== 'project_directory' && entry.table !== 'worktree') continue
      const row = db.prepare(`select * from ${entry.table} where project_id = ? and directory = ?`).get(entry.projectId, entry.directory)
      if (row) rows.push({ table: entry.table, row })
    }
    db.close()
    const backup = beginBackup('delete-orphans', [], { entries, rows })
    const deleted = writeTransaction((writer) => {
      let count = 0
      for (const entry of entries) {
        if (entry.table !== 'project_directory' && entry.table !== 'worktree') continue
        count += writer
          .prepare(`delete from ${entry.table} where project_id = ? and directory = ?`)
          .run(entry.projectId, entry.directory).changes
      }
      return count
    })
    return { deleted, backup }
  },

  async reopenProject(ids) {
    const settings = readSettings() || {}
    const projects = Array.isArray(settings.projects) ? [...settings.projects] : []
    const db = openDb(true)
    const added = []
    for (const id of ids) {
      const row = db.prepare('select worktree from project where id = ?').get(id)
      if (!row) continue
      const dir = row.worktree.replace(/\\/g, '/')
      if (projects.some((p) => normalizeDir(p.path) === normalizeDir(dir))) continue
      const now = Date.now()
      added.push({
        id: projectIdFor(dir),
        path: windowsPath(dir),
        label: path.basename(dir),
        color: pickColor(projects),
        addedAt: now,
        lastOpenedAt: now,
        sidebarCollapsed: false,
      })
    }
    db.close()
    if (added.length === 0) return { added: 0 }
    const saved = await persistProjects([...projects, ...added])
    return { added: added.length, live: saved.live, backup: saved.backup }
  },

  deleteLegacyStorage() {
    if (!dirExists(LEGACY_STORAGE_DIR)) return { moved: false, message: '旧版 storage 目录不存在' }
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(BACKUP_DIR, `${stamp}-legacy-storage`)
    fs.renameSync(LEGACY_STORAGE_DIR, target)
    return { moved: true, backup: target }
  },

  purgeLegacyStorage() {
    if (!dirExists(LEGACY_STORAGE_DIR)) return { removed: false, message: '旧版 storage 目录不存在' }
    const stats = walkSize(LEGACY_STORAGE_DIR)
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(BACKUP_DIR, `${stamp}-legacy-storage`)
    fs.cpSync(LEGACY_STORAGE_DIR, target, { recursive: true })
    fs.rmSync(LEGACY_STORAGE_DIR, { recursive: true, force: true })
    return { removed: true, backup: target, ...stats }
  },

  restoreBackup(name) {
    const full = path.join(BACKUP_DIR, path.basename(String(name || '')))
    if (!fs.existsSync(full)) throw new Error('备份不存在')
    const stat = fs.statSync(full)

    if (stat.isDirectory()) {
      if (dirExists(LEGACY_STORAGE_DIR)) throw new Error('旧版 storage 目录已存在，先清理再还原')
      fs.renameSync(full, LEGACY_STORAGE_DIR)
      return { restored: 1, kind: 'legacy-storage' }
    }

    const data = JSON.parse(fs.readFileSync(full, 'utf8'))
    if (data.action === 'delete-orphans') {
      const restored = writeTransaction((db) => {
        let count = 0
        if (Array.isArray(data.rows) && data.rows.length > 0) {
          for (const item of data.rows) {
            if (item.table !== 'project_directory' && item.table !== 'worktree') continue
            count += insertRows(db, item.table, [item.row])
          }
          return count
        }
        for (const entry of data.entries || []) {
          if (entry.table !== 'project_directory' && entry.table !== 'worktree') continue
          count += db
            .prepare(`insert or replace into ${entry.table} (project_id, directory, time_created) values (?, ?, ?)`)
            .run(entry.projectId, entry.directory, Date.now()).changes
        }
        return count
      })
      return { restored, kind: 'orphans' }
    }

    if (!['delete-projects', 'delete-sessions'].includes(data.action)) {
      throw new Error('这种备份不支持还原')
    }

    const restored = writeTransaction((db) => {
      let count = 0
      for (const [key, table] of RESTORE_ORDER) {
        count += insertRows(db, table, data[key] || [])
      }
      return count
    })
    return { restored, kind: data.action }
  },

  deleteBackup(name) {
    const full = path.join(BACKUP_DIR, path.basename(String(name || '')))
    if (!fs.existsSync(full)) throw new Error('备份不存在')
    fs.rmSync(full, { recursive: true, force: true })
    return { removed: true }
  },
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 50_000_000) reject(new Error('payload too large'))
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, { ok: true, data: snapshot() })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/apply') {
        const body = await readBody(req)
        const handler = actions[body.action]
        if (!handler) return sendJson(res, 400, { ok: false, error: `未知操作 ${body.action}` })
        const isNamed = body.action === 'restoreBackup' || body.action === 'deleteBackup'
        const result = isNamed
          ? await handler(body.name)
          : await handler(body.entries ?? body.ids ?? [])
        return sendJson(res, 200, { ok: true, data: result })
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error?.message || String(error) })
    }
  })
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`
  exec(command)
}

function listen(port, attempt = 0) {
  if (attempt > 20) throw new Error('找不到可用端口')
  const server = createServer()
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') listen(port + 1, attempt + 1)
    else throw error
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`
    console.log(`opencode 清理工具: ${url}`)
    console.log(`数据库: ${DB_PATH}`)
    console.log(`OpenChamber 设置: ${SETTINGS_PATH}`)
    if (process.argv.includes('--open')) openBrowser(url)
  })
}

listen(PORT_START)
