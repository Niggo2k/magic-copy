// Converts a blob of HTML with inline style="..." attributes into HTML where
// those declarations have been translated to Tailwind utility classes.
//
// Uses css-to-tailwindcss (Tailwind v3-era class names — identical in v4 for
// the vast majority of utilities). The converter is driven through PostCSS on
// a synthetic rule per element (".__mc { <decls> }") which keeps the logic
// self-contained and never leaks the fake selector back into the HTML.
//
// Anything the resolver can't map becomes an arbitrary-property utility
// ("[will-change:transform]") so no styling is silently dropped.

import { TailwindConverter } from "css-to-tailwindcss"

// One converter instance — its resolved Tailwind config is cached internally.
const converter = new TailwindConverter({
  arbitraryPropertiesIsEnabled: true,
  postCSSPlugins: []
})

async function declarationsToClasses(decls: string): Promise<string> {
  const cleaned = decls.trim()
  if (!cleaned) return ""
  try {
    const { nodes } = await converter.convertCSS(`.__mc{${cleaned}}`)
    const classes = new Set<string>()
    for (const node of nodes) {
      for (const cls of node.tailwindClasses) classes.add(cls)
    }
    return Array.from(classes).join(" ")
  } catch {
    return ""
  }
}

// Match style="..." or style='...'. The serializer in lib/inline-styles.ts
// always emits double-quoted values; non-greedy capture covers both.
const STYLE_ATTR_RE = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi
const CLASS_ATTR_RE = /\sclass\s*=\s*(["'])([\s\S]*?)\1/i

function htmlEscapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;")
}

// Walk the HTML string, rewriting each opening tag that carries a style=
// attribute. Conversions run in parallel so the PostCSS pipeline amortises
// across elements.
export async function convertHtmlToTailwind(html: string): Promise<string> {
  const tagRe = /<([a-zA-Z][^\s/>]*)([^>]*?)(\/?)>/g
  type Hit = {
    fullMatch: string
    tagName: string
    attrs: string
    selfClose: string
    decls: string
    index: number
  }
  const hits: Hit[] = []
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html)) !== null) {
    const attrs = m[2]
    const styleMatch = STYLE_ATTR_RE.exec(attrs)
    STYLE_ATTR_RE.lastIndex = 0
    if (!styleMatch) continue
    hits.push({
      fullMatch: m[0],
      tagName: m[1],
      attrs,
      selfClose: m[3],
      decls: styleMatch[2],
      index: m.index
    })
  }

  if (hits.length === 0) return html

  const classLists = await Promise.all(
    hits.map((h) => declarationsToClasses(h.decls))
  )

  let out = ""
  let cursor = 0
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    const tailwindClasses = classLists[i]
    out += html.slice(cursor, h.index)

    const attrsWithoutStyle = h.attrs.replace(STYLE_ATTR_RE, "")

    let nextAttrs: string
    const existingClass = CLASS_ATTR_RE.exec(attrsWithoutStyle)
    if (existingClass) {
      const quote = existingClass[1]
      const merged = [existingClass[2], tailwindClasses]
        .filter(Boolean)
        .join(" ")
      nextAttrs = attrsWithoutStyle.replace(
        CLASS_ATTR_RE,
        ` class=${quote}${htmlEscapeAttr(merged)}${quote}`
      )
    } else if (tailwindClasses) {
      nextAttrs = `${attrsWithoutStyle} class="${htmlEscapeAttr(tailwindClasses)}"`
    } else {
      nextAttrs = attrsWithoutStyle
    }

    out += `<${h.tagName}${nextAttrs}${h.selfClose}>`
    cursor = h.index + h.fullMatch.length
  }
  out += html.slice(cursor)
  return out
}
