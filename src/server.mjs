import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { DB_PATH, PORT_START, PUBLIC_DIR, SETTINGS_PATH, snapshot } from './core.mjs'
import actions from './actions.mjs'

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
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
          : await handler(body.entries ?? body.ids ?? [], body.target)
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

export function listen(port = PORT_START, attempt = 0) {
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
