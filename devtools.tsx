import { useEffect } from "react"

function DevTools() {
  useEffect(() => {
    chrome.devtools.panels.elements.createSidebarPane(
      "Magic Copy (inline CSS)",
      (sidebar) => {
        sidebar.setPage("tabs/sidebar.html")
      }
    )
  }, [])

  return null
}

export default DevTools
