export type Row = { name: string; tokens: number }
export type Snap = {
  at: number
  model?: string
  percent?: number
  tokens?: number
  window: number
  cats: { name: string; tokens: number; kind: string }[]
  mcp: { server: string; tokens: number; tools: number; loaded: number }[]
  skills?: { total: number; included: number; tokens: number; top: Row[] }
  five?: number
  week?: number
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-panel': { snap: Shaped<Snap | null>; hist: Shaped<number[]> }
  }
}
