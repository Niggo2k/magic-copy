import type { PlasmoCSConfig } from "plasmo"

import { serializeWithInlineStyles } from "~lib/inline-styles"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  all_frames: true,
  run_at: "document_idle"
}

let lastRightClicked: Element | null = null

document.addEventListener(
  "contextmenu",
  (event) => {
    const target = event.target
    lastRightClicked = target instanceof Element ? target : null
  },
  true
)

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  }
}

function flashToast(message: string) {
  const toast = document.createElement("div")
  toast.textContent = message
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    padding: "10px 14px",
    background: "rgba(20, 20, 20, 0.92)",
    color: "#fff",
    font: "13px/1.3 system-ui, sans-serif",
    borderRadius: "8px",
    zIndex: "2147483647",
    boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
    pointerEvents: "none"
  } as CSSStyleDeclaration)
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 1600)
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "COPY_ELEMENT") return
  if (!lastRightClicked || !lastRightClicked.isConnected) {
    flashToast("Magic Copy: no element captured — right-click directly on the element first.")
    sendResponse({ ok: false, reason: "no-target" })
    return
  }
  const html = serializeWithInlineStyles(lastRightClicked)
  copyToClipboard(html).then((ok) => {
    flashToast(ok ? "Copied element with inline CSS" : "Magic Copy: clipboard write failed")
    sendResponse({ ok })
  })
  return true
})
