import { useEffect, useMemo, useRef } from "react"

import { shikiToMonaco } from "@shikijs/monaco"
import { html as htmlBeautify } from "js-beautify"
import * as monaco from "monaco-editor"
import {
  createHighlighter,
  createJavaScriptRegexEngine,
  type Highlighter
} from "shiki"

// Monaco's default workers use a `new Worker(new URL(...))` pattern that Plasmo
// can't bundle for the devtools sidebar. We don't need background workers for
// read-only highlighting, so stub the environment to run everything on the main
// thread.
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

const LANGUAGES = ["html", "css", "javascript"] as const
const THEMES = ["vitesse-dark", "vitesse-light"] as const

let highlighterPromise: Promise<Highlighter> | null = null
let shikiRegistered = false

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // Use the JS regex engine instead of Oniguruma — the WASM binary can't be
    // loaded from a Plasmo-bundled devtools panel, which surfaces as
    // "createOnigurumaEngine is not a function" at runtime.
    highlighterPromise = createHighlighter({
      themes: [...THEMES],
      langs: [...LANGUAGES],
      engine: createJavaScriptRegexEngine()
    }).then((h) => {
      LANGUAGES.forEach((id) => { monaco.languages.register({ id }) })
      if (!shikiRegistered) {
        shikiToMonaco(h, monaco)
        shikiRegistered = true
      }
      return h
    })
  }
  return highlighterPromise
}

interface MonacoSourceProps {
  value: string
  language?: (typeof LANGUAGES)[number]
  dark?: boolean
}

function MonacoSource({
  value,
  language = "html",
  dark = false
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
        return htmlBeautify(stripDeadAttrs(value), {
          indent_size: 2,
          wrap_line_length: 0,
          preserve_newlines: false,
          end_with_newline: true,
          unformatted: []
        })
      } catch {
        return value
      }
    }
    return value
  }, [value, language])

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false

    getHighlighter().then(() => {
      if (disposed || !containerRef.current) return
      editorRef.current = monaco.editor.create(containerRef.current, {
        value: formatted,
        language: "",
        theme: dark ? "vitesse-dark" : "vitesse-light",
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: true,
        fontSize: 12,
        lineHeight: 18,
        lineNumbers: "on",
        lineNumbersMinChars: 3,
        renderLineHighlight: "all",
        // Indentation-based folding works without the HTML language service,
        // which we don't load because Plasmo can't bundle Monaco's web workers.
        folding: true,
        foldingStrategy: "indentation",
        foldingHighlight: true,
        showFoldingControls: "always",
        unfoldOnClickAfterEndOfLine: true,
        contextmenu: false,
        glyphMargin: false,
        scrollbar: { useShadows: false, verticalScrollbarSize: 10 }
      })
    })

    return () => {
      disposed = true
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
    monaco.editor.setTheme(dark ? "vitesse-dark" : "vitesse-light")
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
