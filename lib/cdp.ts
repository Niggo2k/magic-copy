// Minimal typed wrapper around chrome.debugger so Magic Copy can reach into
// Chrome DevTools Protocol from the sidebar panel.
//
// The DevTools UI itself is already attached to the inspected tab via CDP, but
// only ONE CDP client may hold the attachment at a time.  We attach briefly,
// run our snapshot pipeline, and detach immediately so DevTools can resume.

export type Debuggee = { tabId: number }

export interface CDP {
  send<T = unknown>(method: string, params?: unknown): Promise<T>
  detach(): Promise<void>
}

// Promisified chrome.debugger.sendCommand — Chrome emits the last command error
// via chrome.runtime.lastError rather than throwing, so we have to re-throw it
// ourselves or callers never learn a force-state op failed.
function sendCommand<T>(
  target: Debuggee,
  method: string,
  params?: unknown
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, (params ?? {}) as object, (result) => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(`${method}: ${err.message}`))
      else resolve(result as T)
    })
  })
}

export async function attach(tabId: number): Promise<CDP> {
  const target: Debuggee = { tabId }
  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      const err = chrome.runtime.lastError
      if (err) reject(new Error(err.message))
      else resolve()
    })
  })
  try {
    await sendCommand(target, "DOM.enable")
    await sendCommand(target, "CSS.enable")
    await sendCommand(target, "Runtime.enable")
  } catch (e) {
    await detachQuiet(target)
    throw e
  }
  return {
    send: (method, params) => sendCommand(target, method, params),
    detach: () => detachQuiet(target)
  }
}

async function detachQuiet(target: Debuggee): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.debugger.detach(target, () => {
      void chrome.runtime.lastError
      resolve()
    })
  })
}

// ── Helpers for the snapshot pipeline ────────────────────────────────────────

interface DOMQueryAllResp { nodeIds: number[] }
interface DOMGetDocResp { root: { nodeId: number } }
interface DOMGetAttrsResp { attributes: string[] }

// Build a magic-id → nodeId map for every [data-magic-id] element the
// serializer stamped in the live page.
export async function findAllMagicNodeIds(cdp: CDP): Promise<Map<number, number>> {
  const doc = await cdp.send<DOMGetDocResp>("DOM.getDocument", { depth: 0 })
  const all = await cdp.send<DOMQueryAllResp>("DOM.querySelectorAll", {
    nodeId: doc.root.nodeId,
    selector: "[data-magic-id]"
  })
  const map = new Map<number, number>()
  for (const nodeId of all.nodeIds) {
    const attrs = await cdp.send<DOMGetAttrsResp>("DOM.getAttributes", { nodeId })
    for (let i = 0; i + 1 < attrs.attributes.length; i += 2) {
      if (attrs.attributes[i] === "data-magic-id") {
        const magicId = Number(attrs.attributes[i + 1])
        if (!Number.isNaN(magicId)) map.set(magicId, nodeId)
        break
      }
    }
  }
  return map
}

export async function forcePseudo(
  cdp: CDP,
  nodeId: number,
  pseudos: string[]
): Promise<void> {
  await cdp.send("CSS.forcePseudoState", {
    nodeId,
    forcedPseudoClasses: pseudos
  })
}
