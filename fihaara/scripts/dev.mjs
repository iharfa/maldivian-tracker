// Runs the API server and the Vite dev server together.
import { spawn } from 'node:child_process'

const procs = [
  { name: 'server', cmd: 'npm', args: ['run', 'dev:server'] },
  { name: 'web', cmd: 'npm', args: ['run', 'dev:web'] },
].map(({ name, cmd, args }) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  const prefix = (line) => `[${name}] ${line}`
  p.stdout.on('data', (d) => process.stdout.write(d.toString().split('\n').filter(Boolean).map(prefix).join('\n') + '\n'))
  p.stderr.on('data', (d) => process.stderr.write(d.toString().split('\n').filter(Boolean).map(prefix).join('\n') + '\n'))
  p.on('exit', (code) => {
    console.log(`[${name}] exited with code ${code}`)
    for (const other of procs) if (other !== p && other.exitCode === null) other.kill()
    process.exitCode = code ?? 0
  })
  return p
})

process.on('SIGINT', () => procs.forEach((p) => p.kill('SIGINT')))
process.on('SIGTERM', () => procs.forEach((p) => p.kill('SIGTERM')))
