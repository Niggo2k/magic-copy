import { useCallback, useEffect, useRef, useState } from "react"

import MonacoSource from "~components/MonacoSource"
import { convertHtmlToTailwind } from "~lib/css-to-tailwind"
import { buildDevtoolsEvalSnippet } from "~lib/inline-styles"
import {
  CAPTURABLE_STATES,
  snapshotStateOverrides,
  splitSlot,
  type CapturableState,
  type StateSnapshotTable
} from "~lib/state-snapshot"

// ── Types ─────────────────────────────────────────────────────────────────────

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "ok"; bytes: number }
  | { kind: "error"; message: string }

type Tab = "preview" | "source" | "states"

type OutputFormat = "css" | "tailwind"

interface StateMapEntry {
  id: number      // matches data-magic-id stamped by serializeLive
  label: string   // tag.class#id (short, human-readable)
  states: string[] // pseudo-classes that have at least one matching rule
}

interface EvalResult {
  frozen: string         // base + pseudo overrides inlined → clipboard
  liveHTML: string       // base + custom props + data-magic-id → preview base
  liveCSS: string        // :root vars + @font-face + data-magic-id:state rules → preview live
  forcedStateCSS: Record<string, string> // per-pseudo CSS with the pseudo stripped → "force state" overlay
  stateMap: StateMapEntry[] // per-element pseudo states for the States panel
  pageBackground: string // computed background of the inspected page
  isDark: boolean        // whether prefers-color-scheme: dark is active
  schemeCSS: { dark: string; light: string } // inner rules from prefers-color-scheme media queries
}

// Pseudo-class → data attribute polyfill (kept in sync with PSEUDO_ATTR_MAP in
// lib/inline-styles.ts).  Used to drive per-element state forcing without
// re-rendering the iframe.
const PER_ELEMENT_STATE_ATTRS: Record<string, string> = {
  "hover":         "data-mc-hover",
  "active":        "data-mc-active",
  "focus":         "data-mc-focus",
  "focus-visible": "data-mc-focus",
  "focus-within":  "data-mc-focus-within",
  "visited":       "data-mc-visited",
  "checked":       "data-mc-checked",
  "disabled":      "data-mc-disabled"
}

interface PseudoState {
  id: string
  label: string
}

const PSEUDO_STATES: PseudoState[] = [
  { id: "hover",         label: ":hover" },
  { id: "active",        label: ":active" },
  { id: "focus",         label: ":focus" },
  { id: "focus-visible", label: ":focus-visible" },
  { id: "focus-within",  label: ":focus-within" },
  { id: "visited",       label: ":visited" },
  { id: "checked",       label: ":checked" },
  { id: "disabled",      label: ":disabled" },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function isCapturable(s: string): s is CapturableState {
  return (CAPTURABLE_STATES as readonly string[]).includes(s)
}

function toCapturableSet(src: Set<string>): Set<CapturableState> {
  const out = new Set<CapturableState>()
  src.forEach((s) => { if (isCapturable(s)) out.add(s) })
  return out
}

function toCapturablePerElement(
  src: Map<number, Set<string>>
): Map<number, Set<CapturableState>> {
  const out = new Map<number, Set<CapturableState>>()
  src.forEach((set, id) => {
    const narrow = toCapturableSet(set)
    if (narrow.size) out.set(id, narrow)
  })
  return out
}

function evalInInspectedWindow(expression: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      if (exceptionInfo?.isError || exceptionInfo?.isException) {
        reject(new Error(exceptionInfo.value || exceptionInfo.description || "eval failed"))
        return
      }
      resolve(result)
    })
  })
}

function buildPreviewDoc(
  liveHTML: string,
  liveCSS: string,
  forcedStateCSS: Record<string, string>,
  activeStates: Set<string>,
  pageBackground: string,
  isDark: boolean
): string {
  let forced = ""
  activeStates.forEach((state) => {
    const css = forcedStateCSS?.[state]
    if (css) forced += css
  })
  return `<!DOCTYPE html>
<html style="color-scheme:${isDark ? "dark" : "light"}">
<head>
<meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: ${pageBackground};
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 16px;
  }
  /* Shrink-wrap the element so flex centering kicks in when it fits.
     max-width: 100% prevents it from overflowing when it's too wide. */
  .mc-wrap {
    width: fit-content;
    max-width: 100%;
    min-width: 0;
  }
${liveCSS}
/* Forced pseudo-state overlays (toggled via chips — always applied). */
${forced}
</style>
</head>
<body><div class="mc-wrap">${liveHTML}</div></body>
</html>`
}

// Snapshot-driven preview swapper.  On real mouseenter / focusin / mousedown
// we read the snapshot table produced by CDP (CSS.forcePseudoState + a live
// getComputedStyle) and apply the diff inline with !important.  On leave /
// blur / up we restore the element's base inline style.  This replaces the
// old data-attribute polyfill: we no longer rely on the iframe's CSS rules
// matching the host page's compound selectors — the browser already resolved
// them in the snapshot.
function wireStateSnapshotSwapper(
  iframe: HTMLIFrameElement,
  snapshot: StateSnapshotTable,
  perElement: Map<number, Set<CapturableState>>,
  activeGlobal: Set<CapturableState>
): () => void {
  const doc = iframe.contentDocument
  if (!doc) return () => {}
  const els = Array.from(doc.querySelectorAll<HTMLElement>("[data-magic-id]"))
  const baseStyles = new WeakMap<HTMLElement, string>()
  for (const el of els) baseStyles.set(el, el.style.cssText)

  // Map magic-id → element, for descendant application.
  const byMagic = new Map<number, HTMLElement>()
  for (const el of els) {
    const id = Number(el.getAttribute("data-magic-id"))
    if (!Number.isNaN(id)) byMagic.set(id, el)
  }

  // Each element may have multiple active state "sources" at once: the
  // global activeStates chips, the per-element States panel toggles, and
  // real mouse/keyboard events.  Track them as sets so we can add/remove
  // without trampling each other.  Rendering re-applies every active slot
  // in a fixed order.
  const activeByBearer = new Map<number, Set<CapturableState>>()

  function seed(set: Set<CapturableState> | undefined, states: Iterable<CapturableState>) {
    const s = set ?? new Set<CapturableState>()
    for (const st of states) s.add(st)
    return s
  }

  // Seed: global chips apply to every bearer that has a slot for that state.
  for (const bearerStr in snapshot) {
    const bearer = Number(bearerStr)
    const slots = snapshot[bearer] ?? {}
    const seeded = new Set<CapturableState>()
    for (const s of activeGlobal) if (slots[s]) seeded.add(s)
    const perEl = perElement.get(bearer)
    if (perEl) for (const s of perEl) if (slots[s]) seeded.add(s)
    if (seeded.size) activeByBearer.set(bearer, seeded)
  }

  function render(bearer: number) {
    const slots = snapshot[bearer] ?? {}
    const active = activeByBearer.get(bearer) ?? new Set<CapturableState>()

    // Collect: targetEl → props.  Start from base style for every element
    // we might touch this render, then overlay every active slot.
    const touched = new Map<HTMLElement, Record<string, string>>()
    const bearerEl = byMagic.get(bearer)
    if (!bearerEl) return
    touched.set(bearerEl, {})
    for (const state of active) {
      const slot = slots[state]
      if (!slot) continue
      const { self, descendants } = splitSlot(slot)
      Object.assign(touched.get(bearerEl)!, self)
      for (const descIdStr in descendants) {
        const descId = Number(descIdStr)
        const descEl = byMagic.get(descId)
        if (!descEl) continue
        if (!touched.has(descEl)) touched.set(descEl, {})
        Object.assign(touched.get(descEl)!, descendants[descId])
      }
    }

    // Apply: reset to base, then set overrides.
    touched.forEach((overrides, el) => {
      el.style.cssText = baseStyles.get(el) ?? ""
      for (const prop in overrides) {
        try {
          el.style.setProperty(prop, overrides[prop], "important")
        } catch {
          /* ignore invalid prop */
        }
      }
    })
  }

  // Render initial state for every bearer that has global or per-element
  // pre-seeded state.
  activeByBearer.forEach((_s, bearer) => render(bearer))

  // Wire live events per bearer.
  const cleanupFns: Array<() => void> = []
  for (const bearerStr in snapshot) {
    const bearer = Number(bearerStr)
    const slots = snapshot[bearer] ?? {}
    const bearerEl = byMagic.get(bearer)
    if (!bearerEl) continue

    const activate = (state: CapturableState) => {
      if (!slots[state]) return
      const set = seed(activeByBearer.get(bearer), [state])
      activeByBearer.set(bearer, set)
      render(bearer)
    }
    const deactivate = (state: CapturableState) => {
      // Only remove if the state isn't also pinned by a chip toggle.
      if (activeGlobal.has(state)) return
      if (perElement.get(bearer)?.has(state)) return
      const set = activeByBearer.get(bearer)
      if (!set) return
      set.delete(state)
      if (set.size === 0) activeByBearer.delete(bearer)
      render(bearer)
    }

    const onEnter = () => activate("hover")
    const onLeave = () => {
      deactivate("hover")
      deactivate("active")
    }
    const onDown = () => activate("active")
    const onUp = () => deactivate("active")
    const onFocusIn = () => {
      activate("focus")
      activate("focus-visible")
      activate("focus-within")
    }
    const onFocusOut = () => {
      deactivate("focus")
      deactivate("focus-visible")
      deactivate("focus-within")
    }

    bearerEl.addEventListener("mouseenter", onEnter)
    bearerEl.addEventListener("mouseleave", onLeave)
    bearerEl.addEventListener("mousedown", onDown)
    bearerEl.addEventListener("mouseup", onUp)
    bearerEl.addEventListener("focusin", onFocusIn)
    bearerEl.addEventListener("focusout", onFocusOut)
    cleanupFns.push(() => {
      bearerEl.removeEventListener("mouseenter", onEnter)
      bearerEl.removeEventListener("mouseleave", onLeave)
      bearerEl.removeEventListener("mousedown", onDown)
      bearerEl.removeEventListener("mouseup", onUp)
      bearerEl.removeEventListener("focusin", onFocusIn)
      bearerEl.removeEventListener("focusout", onFocusOut)
    })
  }

  return () => cleanupFns.forEach((fn) => fn())
}

// Bake snapshot overrides into the frozen clipboard HTML for every
// per-element forced state.  Rewrites <... data-magic-id="N" style="...">
// to append !important declarations from the snapshot.
function bakeSnapshotIntoFrozen(
  frozenHtml: string,
  snapshot: StateSnapshotTable,
  perElement: Map<number, Set<CapturableState>>
): string {
  if (perElement.size === 0) return frozenHtml
  // Collect per-target-magic-id → extra declarations.
  const extras = new Map<number, Record<string, string>>()
  perElement.forEach((states, bearerId) => {
    const slots = snapshot[bearerId] ?? {}
    for (const s of states) {
      const slot = slots[s]
      if (!slot) continue
      const { self, descendants } = splitSlot(slot)
      if (Object.keys(self).length) {
        const cur = extras.get(bearerId) ?? {}
        extras.set(bearerId, { ...cur, ...self })
      }
      for (const descStr in descendants) {
        const descId = Number(descStr)
        const cur = extras.get(descId) ?? {}
        extras.set(descId, { ...cur, ...descendants[descId] })
      }
    }
  })
  if (extras.size === 0) return frozenHtml

  // Rewrite the HTML in place by scanning for data-magic-id="N" attrs.
  return frozenHtml.replace(
    /data-magic-id="(\d+)"([^>]*?)style="([^"]*)"/g,
    (match, idStr: string, between: string, style: string) => {
      const id = Number(idStr)
      const add = extras.get(id)
      if (!add) return match
      let appended = style
      if (appended && !appended.trimEnd().endsWith(";")) appended += ";"
      for (const p in add) appended += `${p}:${add[p]} !important;`
      return `data-magic-id="${idStr}"${between}style="${appended}"`
    }
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

function Sidebar() {
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const [result, setResult] = useState<EvalResult | null>(null)
  const [snapshot, setSnapshot] = useState<StateSnapshotTable>({})
  const [activeTab, setActiveTab] = useState<Tab>("preview")
  const [activeStates, setActiveStates] = useState<Set<string>>(new Set())
  const [perElementStates, setPerElementStates] = useState<Map<number, Set<string>>>(new Map())
  const [previewDark, setPreviewDark] = useState<boolean>(false)
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("css")
  const [tailwindFrozen, setTailwindFrozen] = useState<string | null>(null)
  const [tailwindConverting, setTailwindConverting] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const swapperCleanupRef = useRef<(() => void) | null>(null)

  // Bake snapshot overrides for any pinned per-element states into the frozen
  // HTML used by the Source tab and Tailwind conversion.
  const bakedFrozen = result
    ? bakeSnapshotIntoFrozen(
        result.frozen,
        snapshot,
        toCapturablePerElement(perElementStates)
      )
    : ""

  // Recompute Tailwind output whenever a new copy lands or the user switches
  // to Tailwind mode. Cancelled via `cancelled` flag so a slow conversion
  // can't overwrite a newer one.
  useEffect(() => {
    if (!result || outputFormat !== "tailwind") return
    if (tailwindFrozen !== null) return
    let cancelled = false
    setTailwindConverting(true)
    convertHtmlToTailwind(bakedFrozen)
      .then((converted) => {
        if (!cancelled) setTailwindFrozen(converted)
      })
      .catch(() => {
        if (!cancelled) setTailwindFrozen(bakedFrozen)
      })
      .finally(() => {
        if (!cancelled) setTailwindConverting(false)
      })
    return () => {
      cancelled = true
    }
  }, [result, outputFormat, tailwindFrozen, bakedFrozen])

  const toggleState = useCallback((id: string) => {
    setActiveStates((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const togglePerElementState = useCallback((magicId: number, state: string) => {
    setPerElementStates((prev) => {
      const next = new Map(prev)
      const states = new Set(next.get(magicId) ?? [])
      if (states.has(state)) states.delete(state)
      else states.add(state)
      if (states.size === 0) next.delete(magicId)
      else next.set(magicId, states)
      return next
    })
  }, [])

  const handleCopy = useCallback(async () => {
    setStatus({ kind: "working" })
    try {
      const states = Array.from(activeStates)
      const perElementStatesObj: Record<number, string[]> = {}
      perElementStates.forEach((set, id) => {
        perElementStatesObj[id] = Array.from(set)
      })
      const snippet = buildDevtoolsEvalSnippet(states, perElementStatesObj)
      const raw = (await evalInInspectedWindow(snippet)) as
        | EvalResult
        | { __magicCopyError: string }

      if (raw && typeof raw === "object" && "__magicCopyError" in raw) {
        setStatus({ kind: "error", message: raw.__magicCopyError })
        return
      }

      const evalResult = raw as EvalResult
      if (typeof evalResult.frozen !== "string") {
        setStatus({ kind: "error", message: "Unexpected result from inspected window." })
        return
      }

      // CDP-based state capture.  Uses chrome.debugger to attach to the tab,
      // call CSS.forcePseudoState, and diff getComputedStyle — giving us the
      // browser's own resolution of compound selectors like .foo:hover:not(.x).
      // DevTools itself holds the same attachment, so this can fail; on
      // failure the preview falls back to CSS-rule triple-emission.
      const tabId = chrome.devtools?.inspectedWindow?.tabId
      let snap: StateSnapshotTable = {}
      if (typeof tabId === "number") {
        try {
          snap = await snapshotStateOverrides(tabId, evalResult.stateMap ?? [])
        } catch {
          snap = {}
        }
      }

      setResult(evalResult)
      setSnapshot(snap)
      setTailwindFrozen(null) // invalidate the previous Tailwind conversion
      setPreviewDark(evalResult.isDark)
      setPerElementStates(new Map()) // fresh subtree → drop stale magicId selections
      setActiveTab("preview")

      // Bake any per-element pinned states into the frozen clipboard copy.
      // On a fresh copy we just reset perElementStates, so baking is a no-op
      // here — but keeping the call keeps the data path uniform for the
      // future case where state is pinned before re-copy.
      const baked = bakeSnapshotIntoFrozen(
        evalResult.frozen,
        snap,
        toCapturablePerElement(perElementStates)
      )

      if (outputFormat === "tailwind") {
        try {
          const converted = await convertHtmlToTailwind(baked)
          setTailwindFrozen(converted)
          await navigator.clipboard.writeText(converted)
          setStatus({ kind: "ok", bytes: converted.length })
        } catch (err) {
          await navigator.clipboard.writeText(baked)
          setStatus({
            kind: "error",
            message:
              "Tailwind conversion failed, copied raw CSS instead: " +
              (err instanceof Error ? err.message : String(err))
          })
        }
        return
      }

      await navigator.clipboard.writeText(baked)
      setStatus({ kind: "ok", bytes: baked.length })
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }, [activeStates, perElementStates, outputFormat])

  return (
    <div style={wrapperStyle}>
      <style>{`
        html, body { margin: 0; padding: 0; background: #1e1f22; }
        .mc-btn { transition: background 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease, transform 80ms ease; }
        .mc-btn:hover:not(:disabled) { filter: brightness(1.12); }
        .mc-btn:active:not(:disabled) { transform: translateY(1px); }
        .mc-btn:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 2px; }
        .mc-btn:disabled { opacity: 0.55; cursor: not-allowed; }
      `}</style>
      {/* ── Toolbar ── */}
      <div style={toolbarStyle}>
        <button
          type="button"
          className="mc-btn"
          onClick={handleCopy}
          disabled={status.kind === "working"}
          style={copyBtnStyle}>
          {status.kind === "working"
            ? "Copying…"
            : outputFormat === "tailwind"
              ? "Copy $0 as Tailwind"
              : "Copy $0 with inline CSS"}
        </button>
        <div style={formatGroupStyle} role="group" aria-label="Output format">
          {(["css", "tailwind"] as OutputFormat[]).map((fmt) => {
            const on = outputFormat === fmt
            return (
              <button
                key={fmt}
                type="button"
                className="mc-btn"
                onClick={() => setOutputFormat(fmt)}
                title={
                  fmt === "css"
                    ? "Inline computed CSS on every element"
                    : "Convert styles to Tailwind utility classes"
                }
                style={{
                  ...formatBtnBase,
                  background: on ? "#3b82f6" : "#2a2d31",
                  color: on ? "#fff" : "#c8ccd1",
                  borderColor: on ? "#3b82f6" : "#3a3e44"
                }}>
                {fmt === "css" ? "CSS" : "Tailwind"}
              </button>
            )
          })}
        </div>
        <StatusBadge
          status={
            tailwindConverting && status.kind !== "working"
              ? { kind: "working" }
              : status
          }
        />
      </div>

      {/* ── Pseudo-state toggles ── */}
      <div style={statesRowStyle}>
        <span style={statesLabelStyle}>Simulate states</span>
        <div style={chipsStyle}>
          {PSEUDO_STATES.map(({ id, label }) => {
            const on = activeStates.has(id)
            return (
              <button
                key={id}
                type="button"
                className="mc-btn"
                onClick={() => toggleState(id)}
                title={`Force ${label} in preview & include those styles in the next copy`}
                style={{
                  ...chipBase,
                  background: on ? "#3b82f6" : "#2a2d31",
                  color: on ? "#fff" : "#c8ccd1",
                  borderColor: on ? "#3b82f6" : "#3a3e44",
                  boxShadow: on ? "0 1px 0 rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.08)" : "none"
                }}>
                {label}
              </button>
            )
          })}
          {activeStates.size > 0 && (
            <button
              type="button"
              className="mc-btn"
              onClick={() => setActiveStates(new Set())}
              style={clearBtnStyle}
              title="Clear all state filters">
              ✕ clear
            </button>
          )}
        </div>
      </div>

      {/* ── Preview / Source tabs ── */}
      {result !== null ? (
        <>
          <div style={tabBarStyle}>
            <TabButton
              label="Preview"
              active={activeTab === "preview"}
              onClick={() => setActiveTab("preview")}
            />
            <TabButton
              label="Source"
              active={activeTab === "source"}
              onClick={() => setActiveTab("source")}
            />
            <TabButton
              label={
                "States" +
                (result.stateMap?.length
                  ? ` (${result.stateMap.length})`
                  : "")
              }
              active={activeTab === "states"}
              onClick={() => setActiveTab("states")}
            />
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="mc-btn"
              onClick={() => setPreviewDark((d) => !d)}
              title={`Switch preview to ${previewDark ? "light" : "dark"} mode`}
              style={schemeToggleStyle}>
              {previewDark ? "☀︎" : "☾"}
            </button>
          </div>

          {activeTab === "preview" ? (
            <iframe
              key={
                result.liveHTML +
                "|" +
                result.liveCSS +
                "|" +
                String(previewDark) +
                "|" +
                Array.from(activeStates).sort().join(",") +
                "|" +
                Array.from(perElementStates.entries())
                  .map(([id, set]) => id + ":" + Array.from(set).sort().join("."))
                  .sort()
                  .join(",")
              }
              ref={iframeRef}
              srcDoc={buildPreviewDoc(
                result.liveHTML,
                result.liveCSS + (previewDark ? result.schemeCSS.dark : result.schemeCSS.light),
                result.forcedStateCSS ?? {},
                activeStates,
                previewDark === result.isDark
                  ? result.pageBackground
                  : previewDark ? "#121212" : "#ffffff",
                previewDark
              )}
              sandbox="allow-same-origin"
              onLoad={(e) => {
                // Tear down any previous swapper before re-wiring (iframe may
                // load fresh on srcDoc change without full remount in some
                // Chromium builds).
                swapperCleanupRef.current?.()
                swapperCleanupRef.current = wireStateSnapshotSwapper(
                  e.currentTarget,
                  snapshot,
                  toCapturablePerElement(perElementStates),
                  toCapturableSet(activeStates)
                )
              }}
              style={iframeStyle}
              title="Element preview"
            />
          ) : activeTab === "source" ? (
            // Source shows the frozen clipboard version (fully self-contained),
            // rendered with Monaco + Shiki for proper HTML/CSS syntax highlighting.
            <div style={sourceWrapperStyle}>
              <MonacoSource
                value={
                  outputFormat === "tailwind"
                    ? tailwindFrozen ?? bakedFrozen
                    : bakedFrozen
                }
                language="html"
                dark={previewDark}
                preserveClasses={outputFormat === "tailwind"}
              />
            </div>
          ) : (
            <StatesPanel
              entries={result.stateMap ?? []}
              perElementStates={perElementStates}
              onToggle={togglePerElementState}
              onReset={() => setPerElementStates(new Map())}
            />
          )}
        </>
      ) : (
        <div style={hintStyle}>
          Select an element in the Elements panel, optionally simulate pseudo
          states above, then click Copy. The result will appear here.
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="mc-btn"
      onClick={onClick}
      style={{
        ...tabBtnBase,
        borderBottom: active ? "2px solid #7aa2ff" : "2px solid transparent",
        color: active ? "#7aa2ff" : "#a9afb8",
        fontWeight: active ? 600 : 500
      }}>
      {label}
    </button>
  )
}

function StatusBadge({ status }: { status: Status }) {
  if (status.kind === "idle") return null
  if (status.kind === "working")
    return <span style={{ ...badgeBase, color: "#a9afb8" }}>Working…</span>
  if (status.kind === "ok")
    return (
      <span style={{ ...badgeBase, color: "#4ade80" }}>
        ✓ {status.bytes.toLocaleString()} chars
      </span>
    )
  return (
    <span style={{ ...badgeBase, color: "#f87171" }}>Error: {status.message}</span>
  )
}

function StatesPanel({
  entries,
  perElementStates,
  onToggle,
  onReset
}: {
  entries: StateMapEntry[]
  perElementStates: Map<number, Set<string>>
  onToggle: (magicId: number, state: string) => void
  onReset: () => void
}) {
  if (!entries.length) {
    return (
      <div style={hintStyle}>
        No pseudo-state rules found targeting any element in this subtree.
        Toggle a global state pill above to force a state on every matching
        element instead.
      </div>
    )
  }
  const totalActive = Array.from(perElementStates.values()).reduce(
    (n, s) => n + s.size,
    0
  )
  return (
    <div style={statesPanelStyle}>
      <div style={statesPanelHeaderStyle}>
        <span style={statesPanelHintStyle}>
          Click a state to force it on a single element. Forced states paint in
          the Preview tab and bake into the next Copy.
        </span>
        {totalActive > 0 && (
          <button
            type="button"
            className="mc-btn"
            onClick={onReset}
            style={clearBtnStyle}
            title="Clear all per-element forced states">
            ✕ reset ({totalActive})
          </button>
        )}
      </div>
      <div style={statesPanelListStyle}>
        {entries.map((entry) => {
          const forced = perElementStates.get(entry.id) ?? new Set<string>()
          return (
            <div key={entry.id} style={stateRowStyle}>
              <code style={stateRowLabelStyle}>{entry.label}</code>
              <div style={stateRowChipsStyle}>
                {entry.states.map((state) => {
                  const on = forced.has(state)
                  return (
                    <button
                      key={state}
                      type="button"
                      className="mc-btn"
                      onClick={() => onToggle(entry.id, state)}
                      title={`Force :${state} on this element`}
                      style={{
                        ...miniChipStyle,
                        background: on ? "#3b82f6" : "#2a2d31",
                        color: on ? "#fff" : "#c8ccd1",
                        borderColor: on ? "#3b82f6" : "#3a3e44"
                      }}>
                      :{state}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const wrapperStyle: React.CSSProperties = {
  font: "12px/1.4 system-ui, -apple-system, sans-serif",
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  overflow: "hidden",
  background: "#1e1f22",
  color: "#e6e8eb",
  colorScheme: "dark"
}

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 10px",
  borderBottom: "1px solid #2b2e33",
  background: "#1e1f22",
  flexShrink: 0
}

const copyBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid #2f6fe6",
  borderRadius: "6px",
  background: "linear-gradient(180deg, #4f8cff 0%, #2f6fe6 100%)",
  color: "#ffffff",
  whiteSpace: "nowrap",
  boxShadow: "0 1px 0 rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.15)"
}

const formatGroupStyle: React.CSSProperties = {
  display: "inline-flex",
  gap: "2px",
  padding: "2px",
  background: "#16181b",
  border: "1px solid #2b2e33",
  borderRadius: "999px"
}

const formatBtnBase: React.CSSProperties = {
  padding: "3px 10px",
  fontSize: "11px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  border: "1px solid",
  borderRadius: "999px",
  cursor: "pointer",
  lineHeight: "1.6"
}

const statesRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  padding: "8px 10px",
  borderBottom: "1px solid #2b2e33",
  background: "#1e1f22",
  flexShrink: 0
}

const statesLabelStyle: React.CSSProperties = {
  color: "#8b9098",
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em"
}

const chipsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "4px"
}

const chipBase: React.CSSProperties = {
  padding: "3px 9px",
  fontSize: "11px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  border: "1px solid",
  borderRadius: "999px",
  cursor: "pointer",
  lineHeight: "1.6"
}

const clearBtnStyle: React.CSSProperties = {
  padding: "3px 9px",
  fontSize: "11px",
  border: "1px solid #3a3e44",
  borderRadius: "999px",
  cursor: "pointer",
  background: "transparent",
  color: "#a9afb8",
  lineHeight: "1.6"
}

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: "1px solid #2b2e33",
  background: "#1e1f22",
  flexShrink: 0
}

const schemeToggleStyle: React.CSSProperties = {
  padding: "4px 10px",
  font: "13px/1 system-ui",
  background: "#2a2d31",
  border: "1px solid #3a3e44",
  borderRadius: "6px",
  cursor: "pointer",
  color: "#e6e8eb",
  alignSelf: "center",
  margin: "4px 6px"
}

const tabBtnBase: React.CSSProperties = {
  padding: "7px 14px",
  font: "inherit",
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: "11px",
  letterSpacing: "0.02em"
}

const iframeStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  border: "none",
  background: "#fff"
}

const sourceWrapperStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  background: "#151619"
}

const hintStyle: React.CSSProperties = {
  color: "#8b9098",
  padding: "12px 14px",
  fontSize: "11px",
  lineHeight: 1.5
}

const badgeBase: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 500
}

const statesPanelStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  background: "#151619"
}

const statesPanelHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 12px",
  borderBottom: "1px solid #2b2e33",
  background: "#1a1c1f",
  flexShrink: 0
}

const statesPanelHintStyle: React.CSSProperties = {
  flex: 1,
  color: "#8b9098",
  fontSize: "11px",
  lineHeight: 1.4
}

const statesPanelListStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "4px 0"
}

const stateRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "6px 12px",
  borderBottom: "1px solid #1f2126"
}

const stateRowLabelStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "11px",
  color: "#c8ccd1",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis"
}

const stateRowChipsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "3px",
  flexShrink: 0
}

const miniChipStyle: React.CSSProperties = {
  padding: "2px 7px",
  fontSize: "10px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  border: "1px solid",
  borderRadius: "999px",
  cursor: "pointer",
  lineHeight: "1.5"
}

export default Sidebar
