import { createServer, type Server as HttpServer } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import { app } from 'electron'

type StreamEvent = {
  type: 'llm.delta' | 'tool.progress' | 'tool.result' | 'tool.confirm' | 'os.preview' | 'hello'
  payload: unknown
  at?: number
}

let httpServer: HttpServer | undefined
let wss: WebSocketServer | undefined
const clients = new Set<WebSocket>()
let port = 0

export function getToolStreamPort(): number {
  return port
}

export function broadcastStreamEvent(event: StreamEvent): void {
  if (!clients.size) return
  const body = JSON.stringify({ ...event, at: event.at ?? Date.now() })
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(body)
  }
}

/** Localhost WebSocket bridge for low-latency tool/LLM events (complements IPC). */
export function startToolStreamServer(): number {
  if (httpServer && port) return port

  httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Rowe tool stream')
  })
  wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (socket) => {
    clients.add(socket)
    socket.send(JSON.stringify({ type: 'hello', payload: { app: 'rowe', port }, at: Date.now() }))
    socket.on('close', () => clients.delete(socket))
  })

  httpServer.listen(0, '127.0.0.1')
  const addr = httpServer.address()
  port = typeof addr === 'object' && addr ? addr.port : 0

  app.on('before-quit', () => stopToolStreamServer())
  return port
}

export function stopToolStreamServer(): void {
  for (const client of clients) {
    try {
      client.close()
    } catch {
      /* ignore */
    }
  }
  clients.clear()
  try {
    wss?.close()
  } catch {
    /* ignore */
  }
  try {
    httpServer?.close()
  } catch {
    /* ignore */
  }
  wss = undefined
  httpServer = undefined
  port = 0
}
