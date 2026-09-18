import { EventEmitter } from 'events'

export type IndexProgress = {
  projectId: string
  status: 'indexing' | 'ready' | 'failed'
  filesSeen: number
  filesTotal: number
  chunksWritten: number
  error?: string
}

class RagEmitter extends EventEmitter {
  progress(payload: IndexProgress): void {
    this.emit('progress', payload)
  }
}

export const ragEvents = new RagEmitter()
