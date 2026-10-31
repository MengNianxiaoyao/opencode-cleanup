import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const { DatabaseSync } = await import('node:sqlite').catch(() => {
  console.error(`需要 Node.js 22.5 或更高版本，当前是 ${process.versions.node}`)
  process.exit(1)
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..')
export const BACKUP_DIR = path.join(ROOT_DIR, 'backups')
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public')
export const PORT_START = Number(process.env.PORT) || 5199

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

export const DB_PATH = resolveDbPath()
export const OPENCODE_DIR = path.dirname(DB_PATH)
export const LEGACY_STORAGE_DIR = path.join(OPENCODE_DIR, 'storage')
export const SETTINGS_PATH = resolveSettingsPath()

export function resolveDesktopSettings() {
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

export function openDb(readOnly = true) {
  const db = new DatabaseSync(DB_PATH, { readOnly })
  db.exec('pragma busy_timeout = 8000')
  if (!readOnly) db.exec('pragma foreign_keys = ON')
  return db
}

export function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {
    return null
  }
}

export function normalizeDir(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function projectIdFor(dir) {
  return `path_${Buffer.from(String(dir).replace(/\\/g, '/')).toString('base64')}`
}

export function windowsPath(dir) {
  return String(dir).replace(/\//g, '\\')
}

export function pickColor(projects, colors) {
  const used = new Set(projects.map((p) => p.color))
  return colors.find((color) => !used.has(color)) || colors[projects.length % colors.length]
}

export function dirExists(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

export function walkSize(dir) {
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

export function sessionStats(db, projectId) {
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

export function placeholders(ids) {
  return ids.map(() => '?').join(',')
}

export function listBackups() {
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
      const restorable = ['delete-projects', 'delete-sessions', 'delete-orphans', 'move-sessions'].includes(action)
      let targets = []
      if (action === 'move-sessions') {
        targets = [data?.target?.worktree, ...(data?.moves || []).map((m) => m.oldDirectory)].filter(Boolean)
      } else if (action === 'delete-projects' || action === 'restore-sessions' || action === 'delete-sessions') {
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
        sessions: data?.sessions?.length || data?.moves?.length || 0,
        messages: data?.messages?.length || 0,
        entries: data?.entries?.length || 0,
        restorable,
        targets: [...new Set(targets)],
      })
    } catch {}
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export function collectSessionData(db, ids) {
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

export function collectProjectData(db, ids) {
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

export function beginBackup(action, ids, payload) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(BACKUP_DIR, `${stamp}-${action}.json`)
  fs.writeFileSync(file, JSON.stringify({ createdAt: new Date().toISOString(), action, ids, ...payload }, null, 2))
  return file
}

export function insertRows(db, table, rows) {
  let count = 0
  for (const row of rows) {
    const columns = Object.keys(row)
    if (columns.length === 0) continue
    const sql = `insert or replace into ${table} (${columns.map((c) => `"${c}"`).join(',')}) values (${columns.map(() => '?').join(',')})`
    count += db.prepare(sql).run(...columns.map((c) => row[c])).changes
  }
  return count
}

export function writeTransaction(fn) {
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

export function snapshot() {
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

  const sessions = db
    .prepare(
      `select s.id, s.project_id, s.title, s.directory, s.time_updated, s.time_archived,
              (select count(*) from session_message where session_id = s.id) as messages
       from session_v2 s
       where s.parent_id is null
       order by s.time_updated desc
       limit 300`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      project: projectById.get(row.project_id)?.worktree || null,
      title: row.title || '(无标题)',
      directory: row.directory,
      updatedAt: row.time_updated,
      archived: row.time_archived != null,
      messages: Number(row.messages),
    }))

  db.close()

  const projects = allProjects
    .map((p) => ({ id: p.id, worktree: p.worktree, open: openPaths.has(normalizeDir(p.worktree)), dirExists: dirExists(p.worktree) }))
    .sort((a, b) => Number(b.open) - Number(a.open) || a.worktree.localeCompare(b.worktree))

  const legacy = dirExists(LEGACY_STORAGE_DIR)
    ? { path: LEGACY_STORAGE_DIR, ...walkSize(LEGACY_STORAGE_DIR) }
    : null

  return {
    paths: { opencode: OPENCODE_DIR, db: DB_PATH, settings: SETTINGS_PATH, legacyStorage: LEGACY_STORAGE_DIR, desktopSettings: desktopSettings.path },
    desktopSettingsFound: desktopSettings.exists,
    settingsFound: Boolean(settings),
    openProjects: openProjects.map((p) => ({ id: p.id, path: p.path, label: p.label })),
    projects,
    closedProjects,
    emptyProjects,
    orphanEntries,
    archivedSessions,
    sessions,
    legacyStorage: legacy,
    backups: listBackups(),
  }
}
