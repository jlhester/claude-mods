export type LogStatus = 'running' | 'done' | 'failed' | 'background' | 'stopped'

export type LogEntry = {
  id: string
  command: string
  description?: string
  status: LogStatus
  output: string
}

declare module 'claude-code' {
  interface PluginState {
    'command-log': { entries: LogEntry[] }
  }
}
