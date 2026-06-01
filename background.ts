const MENU_ID = "magic-copy-inline-css"

function registerMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Copy element with inline CSS",
      contexts: ["all"]
    })
  })
}

chrome.runtime.onInstalled.addListener(registerMenu)
chrome.runtime.onStartup.addListener(registerMenu)

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return
  chrome.tabs.sendMessage(
    tab.id,
    { type: "COPY_ELEMENT", frameId: info.frameId },
    { frameId: info.frameId ?? 0 },
    () => {
      if (chrome.runtime.lastError) {
        // Target frame has no content script (e.g., chrome:// pages). Swallow.
      }
    }
  )
})

export {}
