import fs from 'node:fs'
import path from 'node:path'
import {
  BACKUP_DIR,
  LEGACY_STORAGE_DIR,
  SETTINGS_PATH,
  beginBackup,
  collectProjectData,
  collectSessionData,
  dirExists,
  insertRows,
  normalizeDir,
  openDb,
  pickColor,
  placeholders,
  projectIdFor,
  readSettings,
  walkSize,
  windowsPath,
  writeTransaction,
} from './core.mjs'

const PROJECT_COLORS = ['#d6a312', '#d6409f', '#12a594', '#f76b15', '#8e4ec6', '#e5484d', '#30a46c', '#0091ff', '#f5a623', '#46a758']

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

  if (!SETTINGS_PATH) throw new Error('找不到 OpenChamber 设置文件，无法重开项目')
  const temp = `${SETTINGS_PATH}.cleanup-tmp`
  fs.writeFileSync(temp, JSON.stringify({ ...current, projects }, null, 2))
  fs.renameSync(temp, SETTINGS_PATH)
  return { live: false, backup }
}

function withDescendants(db, ids) {
  const rows = db.prepare('select id, parent_id from session_v2').all()
  const children = new Map()
  for (const row of rows) {
    if (!row.parent_id) continue
    if (!children.has(row.parent_id)) children.set(row.parent_id, [])
    children.get(row.parent_id).push(row.id)
  }
  const selected = new Set()
  const walk = (id) => {
    if (selected.has(id)) return
    selected.add(id)
    for (const child of children.get(id) || []) walk(child)
  }
  for (const id of ids) walk(id)
  return [...selected]
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

  moveSessions(ids, targetProjectId) {
    if (!targetProjectId) throw new Error('请选择目标项目')
    const db = openDb(true)
    const target = db.prepare('select id, worktree from project where id = ?').get(targetProjectId)
    if (!target) {
      db.close()
      throw new Error('目标项目不存在')
    }
    const allIds = withDescendants(db, ids)
    const rows = db.prepare(`select id, project_id, directory, path from session_v2 where id in (${placeholders(allIds)})`).all(...allIds)
    db.close()

    const moves = rows
      .filter((row) => row.project_id !== target.id || normalizeDir(row.directory) !== normalizeDir(target.worktree))
      .map((row) => ({
        id: row.id,
        oldProjectId: row.project_id,
        oldDirectory: row.directory,
        oldPath: row.path,
        newProjectId: target.id,
        newWorktree: target.worktree,
      }))

    if (moves.length === 0) return { movedCount: 0 }

    const backup = beginBackup('move-sessions', ids, { target: { id: target.id, worktree: target.worktree }, moves })
    const movedCount = writeTransaction((writer) => {
      const now = Date.now()
      let count = 0
      for (const move of moves) {
        count += writer
          .prepare('update session_v2 set project_id = ?, directory = ?, time_updated = ? where id = ?')
          .run(target.id, target.worktree, now, move.id).changes
        writer.prepare('update session set project_id = ?, directory = ? where id = ?').run(target.id, target.worktree, move.id)
      }
      return count
    })
    return { movedCount, total: allIds.length, backup }
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
    const db = openDb(true)
    const rows = []
    for (const id of ids) {
      const row = db.prepare('select id, worktree from project where id = ?').get(id)
      if (row) rows.push(row)
    }
    db.close()
    if (rows.length === 0) return { added: 0, touched: 0 }

    const touched = writeTransaction((writer) => {
      const now = Date.now()
      let count = 0
      for (const row of rows) count += writer.prepare('update project set time_active = ? where id = ?').run(now, row.id).changes
      return count
    })

    const settings = readSettings()
    if (!settings) return { touched, added: 0, cli: true }

    const projects = Array.isArray(settings.projects) ? [...settings.projects] : []
    const added = []
    for (const row of rows) {
      const dir = row.worktree.replace(/\\/g, '/')
      if (projects.some((p) => normalizeDir(p.path) === normalizeDir(dir))) continue
      const now = Date.now()
      added.push({
        id: projectIdFor(dir),
        path: windowsPath(dir),
        label: path.basename(dir),
        color: pickColor(projects, PROJECT_COLORS),
        addedAt: now,
        lastOpenedAt: now,
        sidebarCollapsed: false,
      })
    }
    if (added.length === 0) return { added: 0, touched }
    const saved = await persistProjects([...projects, ...added])
    return { added: added.length, live: saved.live, backup: saved.backup, touched }
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

    if (data.action === 'move-sessions') {
      const restored = writeTransaction((db) => {
        let count = 0
        for (const move of data.moves || []) {
          count += db
            .prepare('update session_v2 set project_id = ?, directory = ?, time_updated = ? where id = ?')
            .run(move.oldProjectId, move.oldDirectory, Date.now(), move.id).changes
          db.prepare('update session set project_id = ?, directory = ? where id = ?').run(move.oldProjectId, move.oldDirectory, move.id)
        }
        return count
      })
      return { restored, kind: 'move-sessions' }
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

export default actions
