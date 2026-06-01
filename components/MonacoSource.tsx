import { useEffect, useMemo, useRef } from "react"

import { html as htmlBeautify } from "js-beautify"
import * as monaco from "monaco-editor"

// Plasmo can't bundle Monaco's worker URLs for the devtools panel, so stub the
// worker environment. Monaco's built-in Monarch tokenizers (html/css/js) run
// on the main thread and don't need workers for syntax highlighting — workers
// are only used for IntelliSense, which we don't need for a read-only viewer.
if (typeof self !== "undefined" && !(self as any).MonacoEnvironment) {
  ;(self as any).MonacoEnvironment = {
    getWorker: () => ({
      postMessage: () => {},
      terminate: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })
  }
}

type Language = "html" | "css" | "javascript"

// VS Code-style themes matching the rest of the sidebar chrome. Defined once,
// registered lazily so the module is safe to import in any order.
let themesDefined = false
function ensureThemes() {
  if (themesDefined) return
  themesDefined = true

  monaco.editor.defineTheme("magic-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "tag",                  foreground: "569CD6" },
      { token: "tag.html",             foreground: "569CD6" },
      { token: "metatag.html",         foreground: "569CD6" },
      { token: "metatag.content.html", foreground: "CE9178" },
      { token: "attribute.name",       foreground: "9CDCFE" },
      { token: "attribute.name.html",  foreground: "9CDCFE" },
      { token: "attribute.value",      foreground: "CE9178" },
      { token: "attribute.value.html", foreground: "CE9178" },
      { token: "delimiter",            foreground: "808080" },
      { token: "delimiter.html",       foreground: "808080" },
      { token: "comment",              foreground: "6A9955", fontStyle: "italic" },
      { token: "string",               foreground: "CE9178" },
      { token: "keyword",              foreground: "C586C0" },
      { token: "number",               foreground: "B5CEA8" },
      { token: "operator",             foreground: "D4D4D4" },
      { token: "type",                 foreground: "4EC9B0" }
    ],
    colors: {
      "editor.background":                 "#151619",
      "editor.foreground":                 "#d0d4db",
      "editorLineNumber.foreground":       "#5a6472",
      "editorLineNumber.activeForeground": "#c0c6d0",
      "editor.lineHighlightBackground":    "#1e2024",
      "editor.lineHighlightBorder":        "#1e2024",
      "editorGutter.background":           "#151619",
      "editor.foldBackground":             "#2a2d3180"
    }
  })

  monaco.editor.defineTheme("magic-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "tag",                  foreground: "800000" },
      { token: "tag.html",             foreground: "800000" },
      { token: "metatag.html",         foreground: "800000" },
      { token: "attribute.name",       foreground: "FF0000" },
      { token: "attribute.name.html",  foreground: "FF0000" },
      { token: "attribute.value",      foreground: "0451A5" },
      { token: "attribute.value.html", foreground: "0451A5" },
      { token: "delimiter",            foreground: "808080" },
      { token: "delimiter.html",       foreground: "808080" },
      { token: "comment",              foreground: "008000", fontStyle: "italic" },
      { token: "string",               foreground: "A31515" },
      { token: "keyword",              foreground: "0000FF" },
      { token: "number",               foreground: "098658" }
    ],
    colors: {
      "editor.background":                 "#ffffff",
      "editorLineNumber.foreground":       "#237893",
      "editorLineNumber.activeForeground": "#0b216f",
      "editor.lineHighlightBackground":    "#f3f3f3",
      "editor.lineHighlightBorder":        "#f3f3f3"
    }
  })
}

interface MonacoSourceProps {
  value: string
  language?: Language
  dark?: boolean
  preserveClasses?: boolean
}

function MonacoSource({
  value,
  language = "html",
  dark = false,
  preserveClasses = false
}: MonacoSourceProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  // Clean the HTML (strip dead-weight attributes now that styles are inlined)
  // and pretty-print so the reader sees one element per line plus
  // indentation-based folding in the gutter. Fall back to the raw string if
  // the beautifier throws (e.g. non-HTML input for the css/js variants).
  const formatted = useMemo(() => {
    if (language === "html") {
      try {
        const cleaned = preserveClasses ? value : stripDeadAttrs(value)
        return htmlBeautify(cleaned, {
          indent_size: 2,
          wrap_line_length: 0,
          preserve_newlines: false,
          end_with_newline: true,
          indent_inner_html: true,
          // Default js-beautify keeps <span>, <a>, <strong>, … inline so their
          // parents stay on one line. We want a break after every closing tag,
          // so disable the inline-tag exception list and the "unformatted" and
          // "content_unformatted" passthroughs that opt tags out of formatting.
          inline: [],
          unformatted: [],
          content_unformatted: [],
          // Keep <pre> on one line so its whitespace is preserved.
          extra_liners: []
        } as any)
      } catch {
        return value
      }
    }
    return value
  }, [value, language, preserveClasses])

  useEffect(() => {
    if (!containerRef.current) return

    ensureThemes()
    editorRef.current = monaco.editor.create(containerRef.current, {
      value: formatted,
      language,
      theme: dark ? "magic-dark" : "magic-light",
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineHeight: 18,
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      renderLineHighlight: "all",
      // Indentation-based folding works without the HTML language service
      // (which we skip because Plasmo can't bundle Monaco's workers).
      folding: true,
      foldingStrategy: "indentation",
      foldingHighlight: true,
      showFoldingControls: "always",
      unfoldOnClickAfterEndOfLine: true,
      contextmenu: false,
      glyphMargin: false,
      scrollbar: { useShadows: false, verticalScrollbarSize: 10 }
    })

    return () => {
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (model && model.getValue() !== formatted) {
      model.setValue(formatted)
    }
    if (model) monaco.editor.setModelLanguage(model, language)
  }, [formatted, language])

  useEffect(() => {
    monaco.editor.setTheme(dark ? "magic-dark" : "magic-light")
  }, [dark])

  return <div ref={containerRef} style={containerStyle} />
}

// Remove attributes that carry no meaning once computed styles are inlined.
// Done with a regex — DOMParser would round-trip through the page's HTML
// parser and silently drop/reshape unknown custom elements or self-closed tags.
function stripDeadAttrs(html: string): string {
  return html
    .replace(/\s+class\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+class\s*=\s*'[^']*'/gi, "")
    .replace(/\s+class\s*=\s*[^\s"'>]+/gi, "")
}

const containerStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  minHeight: 0,
  overflow: "hidden"
}

export default MonacoSource
