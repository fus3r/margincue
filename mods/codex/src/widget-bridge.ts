import { VERSION } from './version'

type Globals = { theme?: unknown; toolOutput?: unknown; widgetState?: unknown }
type LegacyBridge = Globals & {
  callTool?: (name: string, args: object) => Promise<unknown>
  sendFollowUpMessage?: (request: { prompt: string }) => void | Promise<void>
  setWidgetState?: (state: object) => void
  notifyIntrinsicHeight?: (height: number) => void
}

const legacy = () => (window as Window & { openai?: LegacyBridge }).openai
class BridgeTimeout extends Error {}

export function connectWidget(onOutput: (output: unknown) => void) {
  const pending = new Map<number, { done: (result: unknown, error: unknown) => void }>()
  let nextId = 0
  const post = (message: object) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*')

  function theme(value: unknown): void {
    if (value === 'dark' || value === 'light') document.documentElement.dataset.theme = value
  }

  function request<T>(method: string, params: object, ms: number): Promise<T> {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id)
        reject(new BridgeTimeout())
      }, ms)
      pending.set(id, { done: (result, error) => {
        window.clearTimeout(timer)
        if (error) reject(error)
        else resolve(result as T)
      } })
      post({ id, method, params })
    })
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return
    const { id, method, params, result, error } = event.data
    if (method === 'ui/notifications/tool-result') onOutput(params)
    else if (method === 'ui/notifications/tool-cancelled') onOutput({ isError: true })
    else if (method === 'ui/notifications/host-context-changed') theme(params?.theme)
    else if (method === 'ui/resource-teardown') post({ id, result: {} })
    else if (typeof id === 'number') {
      const waiting = pending.get(id)
      pending.delete(id)
      waiting?.done(result, error)
    }
  })

  const acceptGlobals = (globals?: Globals) => {
    theme(globals?.theme)
    if (globals?.toolOutput) onOutput(globals.toolOutput)
  }
  window.addEventListener('openai:set_globals', (event) => {
    acceptGlobals((event as CustomEvent<{ globals?: Globals }>).detail?.globals ?? legacy())
  })
  queueMicrotask(() => acceptGlobals(legacy()))

  const ready = window.parent === window ? Promise.resolve(false) : request<{ hostContext?: Globals }>('ui/initialize', {
    appInfo: { name: 'MarginCue', version: VERSION }, appCapabilities: {}, protocolVersion: '2026-01-26',
  }, 2000).then((result) => {
    theme(result?.hostContext?.theme)
    post({ method: 'ui/notifications/initialized' })
    return true
  }, () => false)

  async function call(name: string, args: object, ms: number): Promise<unknown> {
    if (await ready) return request('tools/call', { name, arguments: args }, ms)
    const api = legacy()
    if (api?.callTool) return api.callTool(name, args)
    throw new Error('This view cannot reach MarginCue.')
  }

  return {
    /** Waits on the server for the card to move on: its reading streaming in, then its first preview. */
    read: (args: object) => call('margincue_read', args, 12000),
    sketch: (args: object) => call('margincue_sketch', args, 16000),
    async send(text: string): Promise<void> {
      if (await ready) {
        try {
          const result = await request<{ isError?: boolean }>('ui/message', { role: 'user', content: [{ type: 'text', text }] }, 8000)
          if (!result?.isError) return
        } catch (error) {
          // An unacknowledged message may already be in the thread.
          if (error instanceof BridgeTimeout) throw new Error('Check the thread before sending again. Delivery could not be confirmed.')
        }
      }
      const api = legacy()
      if (api?.sendFollowUpMessage) await api.sendFollowUpMessage({ prompt: text })
      else throw new Error('Could not send. Try again or continue in the thread.')
    },
    state: () => legacy()?.widgetState,
    saveState(state: object): void {
      try { legacy()?.setWidgetState?.(state) } catch {}
    },
    resize(width: number, height: number): void {
      void ready.then((connected) => {
        if (connected) post({ method: 'ui/notifications/size-changed', params: { width, height } })
        else legacy()?.notifyIntrinsicHeight?.(height)
      })
    },
  }
}
