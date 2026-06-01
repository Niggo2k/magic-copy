// State-snapshot pipeline.
//
// For each (magic-id, pseudo-state) pair we want to capture, we:
//   1. Attach CDP to the inspected tab.
//   2. Look up the CDP nodeId for each [data-magic-id] element.
//   3. Force the pseudo-state on the element via CSS.forcePseudoState.
//   4. Read back getComputedStyle for every element in the subtree — this
//      reflects the cascade *as the browser resolves it*, including
//      :not(...), @layer, cross-origin rules, all of it.
//   5. Clear the forced state.
//   6. Diff the result against the baseline snapshot taken before any forces.
//      Only keep properties whose value differs.

import { attach, findAllMagicNodeIds, forcePseudo, type CDP } from "./cdp"

export const CAPTURABLE_STATES = [
  "hover",
  "active",
  "focus",
  "focus-visible",
  "focus-within",
  "visited",
  "checked",
  "disabled"
] as const

export type CapturableState = (typeof CAPTURABLE_STATES)[number]

// result[bearerMagicId][state] is a flat prop map.  Keys starting with
// "__desc:<descMagicId>:" target a descendant element rather than the bearer.
export type StateSnapshotTable = Record<number, Partial<Record<CapturableState, Record<string, string>>>>

function evalInInspectedWindow<T>(expression: string): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, info) => {
      if (info?.isError || info?.isException) {
        reject(new Error(info.value || info.description || "eval failed"))
        return
      }
      resolve(result as T)
    })
  })
}

// Snapshot every [data-magic-id] element's computed style.  Run once before
// any forces (baseline) and once after each force (state snapshot).
// Returns { magicId: { cssProp: value } }.
const SNAPSHOT_EXPR = `
  (() => {
    const out = {}
    const els = document.querySelectorAll("[data-magic-id]")
    els.forEach((el) => {
      const id = Number(el.getAttribute("data-magic-id"))
      if (Number.isNaN(id)) return
      const cs = getComputedStyle(el)
      const props = {}
      for (let i = 0; i < cs.length; i++) {
        const p = cs[i]
        props[p] = cs.getPropertyValue(p)
      }
      out[id] = props
    })
    return out
  })()
`

type AllProps = Record<string, string>
type AllStyles = Record<number, AllProps>

function diff(base: AllProps, forced: AllProps): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k in forced) {
    if (base[k] !== forced[k]) out[k] = forced[k]
  }
  return out
}

// Build a minimal work plan: for each state, the set of nodeIds to force
// that state on.  stateMap (from the existing eval snippet) filters out
// elements with no chance of differing — no point forcing :hover on a
// plain <span> that has no hover rule anywhere.
function buildPlan(
  stateMap: { id: number; states: string[] }[],
  nodeIds: Map<number, number>
): Map<CapturableState, number[]> {
  const plan = new Map<CapturableState, number[]>()
  for (const entry of stateMap) {
    const nodeId = nodeIds.get(entry.id)
    if (!nodeId) continue
    for (const s of entry.states) {
      if (!CAPTURABLE_STATES.includes(s as CapturableState)) continue
      const state = s as CapturableState
      if (!plan.has(state)) plan.set(state, [])
      plan.get(state)!.push(nodeId)
    }
  }
  return plan
}

export async function snapshotStateOverrides(
  tabId: number,
  stateMap: { id: number; states: string[] }[]
): Promise<StateSnapshotTable> {
  const result: StateSnapshotTable = {}
  if (!stateMap.length) return result

  const cdp: CDP = await attach(tabId)
  try {
    const nodeIds = await findAllMagicNodeIds(cdp)
    const plan = buildPlan(stateMap, nodeIds)
    if (!plan.size) return result

    const base = await evalInInspectedWindow<AllStyles>(SNAPSHOT_EXPR)
    const nodeIdToMagic = new Map<number, number>()
    nodeIds.forEach((nid, mid) => nodeIdToMagic.set(nid, mid))

    for (const [state, nodes] of plan) {
      for (const nodeId of nodes) {
        try {
          await forcePseudo(cdp, nodeId, [state])
        } catch {
          // Best-effort — if the browser refuses to force this state on this
          // node (e.g. :checked on a non-input), skip it.
          continue
        }
        const forced = await evalInInspectedWindow<AllStyles>(SNAPSHOT_EXPR)
        try {
          await forcePseudo(cdp, nodeId, [])
        } catch {
          /* ignore */
        }
        const bearerMagic = nodeIdToMagic.get(nodeId)
        if (bearerMagic === undefined) continue
        for (const magicStr in forced) {
          const magicId = Number(magicStr)
          const d = diff(base[magicId] ?? {}, forced[magicId] ?? {})
          if (Object.keys(d).length === 0) continue
          if (!result[bearerMagic]) result[bearerMagic] = {}
          const slot = result[bearerMagic][state] ?? {}
          if (bearerMagic === magicId) {
            Object.assign(slot, d)
          } else {
            for (const prop in d) {
              slot[`__desc:${magicId}:${prop}`] = d[prop]
            }
          }
          result[bearerMagic][state] = slot
        }
      }
    }
  } finally {
    await cdp.detach()
  }
  return result
}

// Split a snapshot slot into "on the bearer itself" + "on descendants".
// Used by the preview swapper and the frozen-copy baker.
export function splitSlot(slot: Record<string, string>): {
  self: Record<string, string>
  descendants: Record<number, Record<string, string>>
} {
  const self: Record<string, string> = {}
  const descendants: Record<number, Record<string, string>> = {}
  for (const key in slot) {
    if (key.startsWith("__desc:")) {
      const rest = key.slice("__desc:".length)
      const colon = rest.indexOf(":")
      if (colon < 0) continue
      const id = Number(rest.slice(0, colon))
      const prop = rest.slice(colon + 1)
      if (!descendants[id]) descendants[id] = {}
      descendants[id][prop] = slot[key]
    } else {
      self[key] = slot[key]
    }
  }
  return { self, descendants }
}
