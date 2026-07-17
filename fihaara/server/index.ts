import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api } from './api.js'
import { ApiError } from './core.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/api/v1/health', (_req, res) => {
  res.json({ ok: true, name: 'fihaara', version: '0.1.0' })
})

app.use('/api/v1', api)

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'unknown API route — see /api/v1' })
})

// serve the built dashboard when present (production mode)
const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
if (existsSync(join(webDir, 'index.html'))) {
  app.use(express.static(webDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next()
    res.sendFile(join(webDir, 'index.html'))
  })
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error(err)
  res.status(500).json({ error: 'internal server error' })
})

const port = Number(process.env.PORT ?? 4646)
app.listen(port, () => {
  console.log(`Fihaara running on http://localhost:${port}`)
})
