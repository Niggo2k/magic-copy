import { useCallback, useState } from "react"

import MonacoSource from "~components/MonacoSource"
import { buildDevtoolsEvalSnippet } from "~lib/inline-styles"

// ── Types ─────────────────────────────────────────────────────────────────────

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "ok"; bytes: number }
  | { kind: "error"; message: string }

type Tab = "preview" | "source"

interface EvalResult {
  frozen: string         // base + pseudo overrides inlined → clipboard
  liveHTML: string       // base + custom props + data-magic-id → preview base
  liveCSS: string        // :root vars + @font-face + data-magic-id:state rules → preview live
  forcedStateCSS: Record<string, string> // per-pseudo CSS with the pseudo stripped → "force state" overlay
  pageBackground: string // computed background of the inspected page
  isDark: boolean        // whether prefers-color-scheme: dark is active
  schemeCSS: { dark: string; light: string } // inner rules from prefers-color-scheme media queries
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

function wireHoverPolyfill(iframe: HTMLIFrameElement) {
  const doc = iframe.contentDocument
  if (!doc) return
  const nodes = doc.querySelectorAll("[data-magic-id]")
  function set(el: Element, attr: string, on: boolean) {
    if (on) el.setAttribute(attr, "")
    else el.removeAttribute(attr)
  }
  nodes.forEach((el) => {
    el.addEventListener("mouseenter", () => set(el, "data-mc-hover", true))
    el.addEventListener("mouseleave", () => {
      set(el, "data-mc-hover", false)
      set(el, "data-mc-active", false)
    })
    el.addEventListener("mousedown", () => set(el, "data-mc-active", true))
    el.addEventListener("mouseup", () => set(el, "data-mc-active", false))
    el.addEventListener("focusin", () => {
      set(el, "data-mc-focus", true)
      set(el, "data-mc-focus-within", true)
    })
    el.addEventListener("focusout", () => {
      set(el, "data-mc-focus", false)
      set(el, "data-mc-focus-within", false)
    })
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

function Sidebar() {
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const [result, setResult] = useState<EvalResult | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>("preview")
  const [activeStates, setActiveStates] = useState<Set<string>>(new Set())
  const [previewDark, setPreviewDark] = useState<boolean>(false)

  const toggleState = useCallback((id: string) => {
    setActiveStates((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const handleCopy = useCallback(async () => {
    setStatus({ kind: "working" })
    try {
      const states = Array.from(activeStates)
      const snippet = buildDevtoolsEvalSnippet(states)
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

      await navigator.clipboard.writeText(evalResult.frozen)
      setStatus({ kind: "ok", bytes: evalResult.frozen.length })
      setResult(evalResult)
      setPreviewDark(evalResult.isDark)
      setActiveTab("preview")
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }, [activeStates])

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
          {status.kind === "working" ? "Copying…" : "Copy $0 with inline CSS"}
        </button>
        <StatusBadge status={status} />
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
                Array.from(activeStates).sort().join(",")
              }
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
              onLoad={(e) => wireHoverPolyfill(e.currentTarget)}
              style={iframeStyle}
              title="Element preview"
            />
          ) : (
            // Source shows the frozen clipboard version (fully self-contained),
            // rendered with Monaco + Shiki for proper HTML/CSS syntax highlighting.
            <div style={sourceWrapperStyle}>
              <MonacoSource
                value={result.frozen}
                language="html"
                dark={previewDark}
              />
            </div>
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

export default Sidebar
