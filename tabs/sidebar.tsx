import { useCallback, useState } from "react"

import { buildDevtoolsEvalSnippet } from "~lib/inline-styles"

// ── Types ─────────────────────────────────────────────────────────────────────

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "ok"; bytes: number }
  | { kind: "error"; message: string }

type Tab = "preview" | "source"

interface EvalResult {
  frozen: string   // base + pseudo overrides inlined → clipboard
  liveHTML: string // base + custom props + data-magic-id → preview base
  liveCSS: string  // :root vars + @font-face + data-magic-id:state rules → preview live
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

function buildPreviewDoc(liveHTML: string, liveCSS: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 8px; background: #fff; }
${liveCSS}
</style>
</head>
<body>${liveHTML}</body>
</html>`
}

// ── Component ─────────────────────────────────────────────────────────────────

function Sidebar() {
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const [result, setResult] = useState<EvalResult | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>("preview")
  const [activeStates, setActiveStates] = useState<Set<string>>(new Set())

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
      {/* ── Toolbar ── */}
      <div style={toolbarStyle}>
        <button
          type="button"
          onClick={handleCopy}
          disabled={status.kind === "working"}
          style={copyBtnStyle}>
          {status.kind === "working" ? "Copying…" : "Copy $0 with inline CSS"}
        </button>
        <StatusBadge status={status} />
      </div>

      {/* ── Pseudo-state toggles ── */}
      <div style={statesRowStyle}>
        <span style={statesLabelStyle}>Simulate states:</span>
        <div style={chipsStyle}>
          {PSEUDO_STATES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => toggleState(id)}
              title={`Include styles from ${label} rules`}
              style={{
                ...chipBase,
                background: activeStates.has(id) ? "#1a73e8" : "#f1f3f4",
                color: activeStates.has(id) ? "#fff" : "#444",
                borderColor: activeStates.has(id) ? "#1a73e8" : "#dadce0"
              }}>
              {label}
            </button>
          ))}
          {activeStates.size > 0 && (
            <button
              type="button"
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
          </div>

          {activeTab === "preview" ? (
            // liveHTML + styles: base inline styles + injected CSS rules so that
            // hovering / focusing inside the iframe fires the real pseudo-state styles.
            <iframe
              key={result.liveHTML + result.liveCSS}
              srcDoc={buildPreviewDoc(result.liveHTML, result.liveCSS)}
              sandbox="allow-same-origin"
              style={iframeStyle}
              title="Element preview"
            />
          ) : (
            // Source shows the frozen clipboard version (fully self-contained).
            <pre style={sourceStyle}>{result.frozen}</pre>
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
      onClick={onClick}
      style={{
        ...tabBtnBase,
        borderBottom: active ? "2px solid #1a73e8" : "2px solid transparent",
        color: active ? "#1a73e8" : "#555",
        fontWeight: active ? 600 : 400
      }}>
      {label}
    </button>
  )
}

function StatusBadge({ status }: { status: Status }) {
  if (status.kind === "idle") return null
  if (status.kind === "working")
    return <span style={{ ...badgeBase, color: "#666" }}>Working…</span>
  if (status.kind === "ok")
    return (
      <span style={{ ...badgeBase, color: "#1a7f37" }}>
        ✓ {status.bytes.toLocaleString()} chars
      </span>
    )
  return (
    <span style={{ ...badgeBase, color: "#b42318" }}>Error: {status.message}</span>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const wrapperStyle: React.CSSProperties = {
  font: "12px/1.4 system-ui, -apple-system, sans-serif",
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  overflow: "hidden"
}

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "7px 10px",
  borderBottom: "1px solid #e0e0e0",
  flexShrink: 0
}

const copyBtnStyle: React.CSSProperties = {
  padding: "5px 10px",
  font: "inherit",
  fontWeight: 500,
  cursor: "pointer",
  border: "1px solid #c3c3c3",
  borderRadius: "4px",
  background: "#fafafa",
  whiteSpace: "nowrap"
}

const statesRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  padding: "7px 10px",
  borderBottom: "1px solid #e0e0e0",
  flexShrink: 0
}

const statesLabelStyle: React.CSSProperties = {
  color: "#666",
  fontSize: "11px",
  fontWeight: 500
}

const chipsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "4px"
}

const chipBase: React.CSSProperties = {
  padding: "2px 7px",
  fontSize: "11px",
  fontFamily: "monospace",
  border: "1px solid",
  borderRadius: "10px",
  cursor: "pointer",
  lineHeight: "1.6",
  transition: "background 0.1s, color 0.1s"
}

const clearBtnStyle: React.CSSProperties = {
  padding: "2px 7px",
  fontSize: "11px",
  border: "1px solid #dadce0",
  borderRadius: "10px",
  cursor: "pointer",
  background: "none",
  color: "#888",
  lineHeight: "1.6"
}

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: "1px solid #e0e0e0",
  flexShrink: 0
}

const tabBtnBase: React.CSSProperties = {
  padding: "5px 12px",
  font: "inherit",
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: "11px"
}

const iframeStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  border: "none",
  background: "#fff"
}

const sourceStyle: React.CSSProperties = {
  flex: 1,
  margin: 0,
  padding: "8px 10px",
  overflowY: "auto",
  overflowX: "auto",
  fontSize: "11px",
  fontFamily: "monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  background: "#f5f5f5",
  lineHeight: 1.5
}

const hintStyle: React.CSSProperties = {
  color: "#777",
  padding: "10px 12px",
  fontSize: "11px"
}

const badgeBase: React.CSSProperties = {
  fontSize: "11px"
}

export default Sidebar
