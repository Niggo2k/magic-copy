// ─── Content-script typed implementation ─────────────────────────────────────
// Right-click path: getComputedStyle is live so it already reflects the active
// visual state (hover, focus, etc.) — no extra pseudo-state logic needed.

export function serializeWithInlineStyles(root: Element): string {
  const clone = root.cloneNode(true) as Element
  const originals: Element[] = [root, ...Array.from(root.querySelectorAll("*"))]
  const clones: Element[] = [clone, ...Array.from(clone.querySelectorAll("*"))]
  for (let i = 0; i < originals.length; i++) {
    const orig = originals[i]
    const target = clones[i] as HTMLElement
    if (!(orig instanceof Element) || !target || !("style" in target)) continue
    const computed = getComputedStyle(orig)
    let css = ""
    for (let j = 0; j < computed.length; j++) {
      const prop = computed[j]
      css += prop + ":" + computed.getPropertyValue(prop) + ";"
    }
    target.style.cssText = css
  }
  return clone.outerHTML
}

// ─── DevTools eval snippet ────────────────────────────────────────────────────
//
// Runs inside chrome.devtools.inspectedWindow.eval.  Full live page DOM is
// available (document.styleSheets, getComputedStyle, $0).
//
// Returns { frozen, liveHTML, liveCSS, forcedStateCSS, pageBackground, isDark, schemeCSS }
// or      { __magicCopyError: string }
//
//  frozen          — clipboard copy.  Every element has all computed standard
//                   properties + resolved pseudo-state overrides (for the
//                   chip-selected states) inlined.  Fully self-contained.
//
//  liveHTML        — preview base.  Every element has all computed standard
//                   properties + all resolved CSS custom properties inlined.
//                   Original class/id/attribute values are preserved so that
//                   the page's CSS selectors continue to match.
//
//  liveCSS         — preview stylesheet injected into the iframe <style> tag:
//                     1. :root { --var: resolved-value } for every custom prop
//                     2. @font-face rules verbatim
//                     3. Every pseudo-state rule from the page's stylesheets,
//                        re-emitted WITH !important on each declaration so they
//                        override the element's inline base styles when the
//                        state fires.  Original selectors are preserved, so
//                        .nav:hover .link works correctly when the user copied
//                        the .nav element (both .nav and .link are present).
//                        Non-color-scheme @media wrappers are kept intact.
//
//  forcedStateCSS  — { hover, active, focus, ... }: CSS per pseudo-state
//                   with the pseudo STRIPPED from each selector, so the rule
//                   applies unconditionally.  Sidebar concatenates the entries
//                   for whichever chips are toggled, emulating DevTools'
//                   :hov "Force state" on every element in the subtree.
//
//  schemeCSS       — { dark, light }: inner rules from prefers-color-scheme
//                   media queries (without wrapper), injected on toggle.

const serializerBody = `
  // ── Utilities ─────────────────────────────────────────────────────────────
  function allSheetRules(fn) {
    for (var si = 0; si < document.styleSheets.length; si++) {
      try { walkRuleList(document.styleSheets[si].cssRules, fn); } catch(e) {}
    }
  }

  function walkRuleList(list, fn) {
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.cssRules) { fn(r, true); } else { fn(r, false); }
    }
  }

  // ── CSS custom properties ─────────────────────────────────────────────────
  function collectCustomPropNames() {
    var names = Object.create(null);
    allSheetRules(function(r) {
      if (!r.style) return;
      for (var pi = 0; pi < r.style.length; pi++) {
        var p = r.style[pi].trim();
        if (p.indexOf('--') === 0) names[p] = 1;
      }
    });
    return Object.keys(names);
  }

  function buildRootVarsCSS(propNames) {
    var root = getComputedStyle(document.documentElement);
    var css = ':root{';
    for (var i = 0; i < propNames.length; i++) {
      var v = root.getPropertyValue(propNames[i]).trim();
      if (v) css += propNames[i] + ':' + v + ';';
    }
    return css + '}';
  }

  // ── Page background + theme ───────────────────────────────────────────────
  function getPageBackground() {
    var isDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var candidates = [document.body, document.documentElement];
    for (var i = 0; i < candidates.length; i++) {
      var bg = getComputedStyle(candidates[i]).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return { color: bg, isDark: isDark };
    }
    return { color: isDark ? '#121212' : '#ffffff', isDark: isDark };
  }

  // ── @font-face ────────────────────────────────────────────────────────────
  function extractFontFaceCSS() {
    var css = '';
    for (var si = 0; si < document.styleSheets.length; si++) {
      var rules; try { rules = document.styleSheets[si].cssRules; } catch(e) { continue; }
      for (var ri = 0; ri < rules.length; ri++) {
        var r = rules[ri];
        if (r instanceof CSSFontFaceRule) { try { css += r.cssText + '\\n'; } catch(e) {} }
      }
    }
    return css;
  }

  // ── prefers-color-scheme rules ────────────────────────────────────────────
  function extractColorSchemeCSS() {
    var dark = '', light = '';
    for (var si = 0; si < document.styleSheets.length; si++) {
      var rules; try { rules = document.styleSheets[si].cssRules; } catch(e) { continue; }
      for (var ri = 0; ri < rules.length; ri++) {
        var r = rules[ri];
        if (!r.cssRules) continue;
        var mq = r.conditionText || (r.media && r.media.mediaText) || '';
        var isDark  = /prefers-color-scheme\\s*:\\s*dark/i.test(mq);
        var isLight = /prefers-color-scheme\\s*:\\s*light/i.test(mq);
        if (!isDark && !isLight) continue;
        for (var ii = 0; ii < r.cssRules.length; ii++) {
          try {
            var text = r.cssRules[ii].cssText + '\\n';
            if (isDark) dark += text; else light += text;
          } catch(e) {}
        }
      }
    }
    return { dark: dark, light: light };
  }

  // ── Shared pseudo-state rule walker ───────────────────────────────────────
  // Walks every stylesheet (incl. adoptedStyleSheets, @media, @supports),
  // finds rules whose selector contains an allowlisted pseudo-class, and
  // delegates selector rewriting to \`transform\`.  Declarations always keep
  // !important so they beat the inline base written by serializeLive.
  //
  // transform(selectorPart, pseudoMatch, nodes): string
  //   - selectorPart: one comma-separated selector (trimmed)
  //   - pseudoMatch:  RegExpExecArray from the pseudo regex (or null)
  //   - nodes:        gatherTree(root)
  //   returns: '' to skip, else one-or-more comma-separated selectors

  // Longer names first so focus-visible/focus-within beat plain focus,
  // placeholder-shown beats shorter prefixes, etc.  Expanded to cover
  // "every STATE OF THE ELEMENT OR CHILD ELEMENTS".
  var MAGIC_PSEUDO = [
    'placeholder-shown','focus-visible','focus-within','read-write','read-only',
    'out-of-range','in-range','any-link','indeterminate','disabled','required',
    'optional','enabled','checked','visited','default','invalid','target',
    'active','hover','focus','valid','blank','link'
  ];
  // Template literal (½) -> eval'd string literal (¼) -> regex source.
  // Four backslashes survive to one regex-level backslash.
  // Lookbehind '(?<![:\\\\])' (in template) -> '(?<![:\\])' (in string) ->
  // regex char class [:\\] meaning "not preceded by another ':' nor by a
  // literal backslash" — so '::before' is excluded AND Tailwind's escaped
  // class name '.hover\\:bg-red-500:hover' is not split at the first ':hover'.
  var MAGIC_PSEUDO_SRC = '(?<![:\\\\\\\\]):(' + MAGIC_PSEUDO.join('|') + ')(?![\\\\w-])';

  function buildDecls(style) {
    var decls = '';
    for (var pi = 0; pi < style.length; pi++) {
      var p = style[pi];
      decls += p + ':' + style.getPropertyValue(p) + ' !important;';
    }
    return decls;
  }

  function walkPseudoRules(root, transform, pseudoSrc) {
    var nodes = gatherTree(root);
    var src = pseudoSrc || MAGIC_PSEUDO_SRC;

    function processRule(r) {
      if (!r.selectorText || !r.style) return '';
      // Fresh regex per rule — non-global, no lastIndex carry-over.
      if (!new RegExp(src, 'i').test(r.selectorText)) return '';
      var decls = buildDecls(r.style);
      if (!decls) return '';
      var out = '';
      var sels = r.selectorText.split(',');
      for (var sp = 0; sp < sels.length; sp++) {
        var sel = sels[sp].trim();
        if (!sel) continue;
        var m = new RegExp(src, 'i').exec(sel);
        var emitted = transform(sel, m, nodes);
        if (emitted) out += emitted + '{' + decls + '}\\n';
      }
      return out;
    }

    function walkList(list) {
      var out = '';
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        // CSSKeyframesRule also has .cssRules (keyframe steps) but must NOT
        // be recursed into — handled by extractKeyframesCSS.
        if (typeof CSSKeyframesRule !== 'undefined' && r instanceof CSSKeyframesRule) continue;
        if (r.cssRules) {
          var mq = (r.media && r.media.mediaText) || '';
          if (/prefers-color-scheme/i.test(mq)) continue;
          var inner = walkList(r.cssRules);
          // Strip @media wrappers that gate by device capability — the iframe's
          // capabilities may not match the host page's, which would silently
          // suppress hover rules (this is the bug where hover "doesn't fire").
          // Examples: @media (hover: hover) { .btn:hover {...} } — we want the
          // .btn:hover rule to ALWAYS be active in the preview.
          var capabilityGated = /\\b(hover|any-hover|pointer|any-pointer)\\s*:/i.test(mq);
          if (mq && inner && !capabilityGated) out += '@media ' + mq + '{' + inner + '}';
          else out += inner;
        } else {
          out += processRule(r);
        }
      }
      return out;
    }

    var css = '';
    for (var si = 0; si < document.styleSheets.length; si++) {
      try { css += walkList(document.styleSheets[si].cssRules); } catch(e) {}
    }
    var adopted = document.adoptedStyleSheets;
    if (adopted && adopted.length) {
      for (var ai = 0; ai < adopted.length; ai++) {
        try { css += walkList(adopted[ai].cssRules); } catch(e) {}
      }
    }
    return css;
  }

  // Map from CSS pseudo-class name to the data-attribute polyfill (set by the
  // tiny <script> injected in the preview iframe).  Pseudos not listed here
  // don't get an attribute variant (they're driven by real state — disabled,
  // checked, visited — and already work without a polyfill).
  var PSEUDO_ATTR_MAP = {
    'hover':         'data-mc-hover',
    'active':        'data-mc-active',
    'focus':         'data-mc-focus',
    'focus-visible': 'data-mc-focus',
    'focus-within':  'data-mc-focus-within'
  };

  // ── Live pseudo-state CSS (triple-emission) ───────────────────────────────
  // For each pseudo-state rule we emit THREE selector variants, comma-joined:
  //   1. ORIGINAL selector verbatim (works when context survives in iframe).
  //   2. [data-magic-id="N"]:hover rest   — browser-native :hover path.
  //   3. [data-magic-id="N"][data-mc-hover] rest   — attribute polyfill path.
  // The third variant is the belt-and-suspenders fix: a tiny script in the
  // iframe toggles data-mc-hover/data-mc-active/data-mc-focus on real events,
  // guaranteeing the state paints even if the browser's :hover pseudo is
  // silently suppressed (e.g. by a @media (hover: hover) wrapper we missed,
  // by a parent pointer-events issue, or by DevTools pane event quirks).
  function buildLivePseudoCSS(root) {
    return walkPseudoRules(root, function(sel, m, nodes) {
      if (!m) return '';
      var anchorSel = sel.slice(0, m.index).trim() || '*';
      var pseudo    = m[0];        // ':hover'
      var pseudoKey = m[1].toLowerCase(); // 'hover'
      var rest      = sel.slice(m.index + m[0].length);
      var attrSel   = PSEUDO_ATTR_MAP[pseudoKey] ? '[' + PSEUDO_ATTR_MAP[pseudoKey] + ']' : '';
      var out = sel; // verbatim first
      for (var ni = 0; ni < nodes.length; ni++) {
        try {
          if (anchorSel === '*' || nodes[ni].matches(anchorSel)) {
            out += ',[data-magic-id="' + ni + '"]' + pseudo + rest;
            if (attrSel) {
              out += ',[data-magic-id="' + ni + '"]' + attrSel + rest;
            }
          }
        } catch(e) {}
      }
      return out;
    });
  }

  // ── Forced-state CSS (per pseudo) ─────────────────────────────────────────
  // Strips the matched pseudo so the rule applies unconditionally — the
  // equivalent of DevTools' "Force element state" but for every element in
  // the copied subtree.  Dual-emitted for the same reason as the live CSS.
  function buildForcedStateCSS(root, pseudoName) {
    var oneSrc = '(?<![:\\\\\\\\]):(' + pseudoName + ')(?![\\\\w-])';
    return walkPseudoRules(root, function(sel, m, nodes) {
      if (!m) return '';
      var anchorSel = sel.slice(0, m.index).trim() || '*';
      var rest      = sel.slice(m.index + m[0].length);
      var strippedOriginal = (anchorSel === '*' ? '' : anchorSel) + rest;
      if (!strippedOriginal.trim()) strippedOriginal = '*';
      var out = strippedOriginal;
      for (var ni = 0; ni < nodes.length; ni++) {
        try {
          if (anchorSel === '*' || nodes[ni].matches(anchorSel)) {
            var tail = rest.trim() ? rest : '';
            out += ',[data-magic-id="' + ni + '"]' + tail;
          }
        } catch(e) {}
      }
      return out;
    }, oneSrc);
  }

  function buildForcedStateMap(root) {
    var STATES = ['hover','active','focus','focus-visible','focus-within','visited','checked','disabled'];
    var out = Object.create(null);
    for (var si = 0; si < STATES.length; si++) {
      try { out[STATES[si]] = buildForcedStateCSS(root, STATES[si]); }
      catch(e) { out[STATES[si]] = ''; }
    }
    return out;
  }

  // ── @keyframes extraction ─────────────────────────────────────────────────
  // Hover rules often reference animations; without the @keyframes definitions
  // the animation fails silently in the iframe.
  function extractKeyframesCSS() {
    var css = '';
    function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (typeof CSSKeyframesRule !== 'undefined' && r instanceof CSSKeyframesRule) {
          try { css += r.cssText + '\\n'; } catch(e) {}
        } else if (r.cssRules) {
          walk(r.cssRules);
        }
      }
    }
    for (var si = 0; si < document.styleSheets.length; si++) {
      try { walk(document.styleSheets[si].cssRules); } catch(e) {}
    }
    var adopted = document.adoptedStyleSheets;
    if (adopted && adopted.length) {
      for (var ai = 0; ai < adopted.length; ai++) {
        try { walk(adopted[ai].cssRules); } catch(e) {}
      }
    }
    return css;
  }

  // ── Frozen-copy helpers (chip-selected states only) ───────────────────────
  function buildOverrideMap(activeStates) {
    if (!activeStates || !activeStates.length) return [];
    var sorted = activeStates.slice().sort(function(a,b){ return b.length - a.length; });
    var regex = new RegExp(':(' + sorted.join('|') + ')', 'gi');
    var rules = [];
    allSheetRules(function(r) {
      if (!r.selectorText || !r.style) return;
      regex.lastIndex = 0;
      if (!regex.test(r.selectorText)) { regex.lastIndex = 0; return; }
      regex.lastIndex = 0;
      var parts = r.selectorText.split(',');
      for (var sp = 0; sp < parts.length; sp++) {
        var original = parts[sp].trim();
        var base = original.replace(regex, '').trim() || '*';
        var props = Object.create(null);
        for (var pi = 0; pi < r.style.length; pi++) {
          var p = r.style[pi];
          props[p] = r.style.getPropertyValue(p);
        }
        rules.push({ base: base, props: props });
      }
      regex.lastIndex = 0;
    });
    return rules;
  }

  function getOverrides(el, overrideRules) {
    var extra = Object.create(null);
    for (var i = 0; i < overrideRules.length; i++) {
      try {
        if (el.matches && el.matches(overrideRules[i].base)) {
          var p = overrideRules[i].props;
          for (var k in p) extra[k] = p[k];
        }
      } catch(e) {}
    }
    return extra;
  }

  // ── Computed CSS builder ──────────────────────────────────────────────────
  function buildComputedCSS(el, customPropNames) {
    var computed = getComputedStyle(el), css = '';
    for (var j = 0; j < computed.length; j++) {
      var p = computed[j];
      css += p + ':' + computed.getPropertyValue(p) + ';';
    }
    for (var ci = 0; ci < customPropNames.length; ci++) {
      var cp = customPropNames[ci];
      var cv = computed.getPropertyValue(cp).trim();
      if (cv) css += cp + ':' + cv + ';';
    }
    return css;
  }

  // ── Serializers ───────────────────────────────────────────────────────────
  function gatherTree(root) {
    var nodes = [root], all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) nodes.push(all[i]);
    return nodes;
  }

  // FROZEN: base computed + chip-state overrides inlined.  Clipboard copy.
  function serializeFrozen(root, overrideRules) {
    var originals = gatherTree(root);
    var clone = root.cloneNode(true);
    var clones = [clone];
    var ca = clone.querySelectorAll('*');
    for (var i = 0; i < ca.length; i++) clones.push(ca[i]);
    for (var k = 0; k < originals.length; k++) {
      var orig = originals[k], target = clones[k];
      if (!(orig instanceof Element) || !target || !('style' in target)) continue;
      var computed = getComputedStyle(orig), css = '';
      for (var j = 0; j < computed.length; j++) {
        var p = computed[j];
        css += p + ':' + computed.getPropertyValue(p) + ';';
      }
      var ov = getOverrides(orig, overrideRules);
      for (var ep in ov) css += ep + ':' + ov[ep] + ';';
      target.style.cssText = css;
    }
    return clone.outerHTML;
  }

  // LIVE: base computed + custom props inlined + data-magic-id stamped.
  // data-magic-id="N" must match the index used in buildLivePseudoCSS.
  function serializeLive(root, customPropNames) {
    var originals = gatherTree(root);
    var clone = root.cloneNode(true);
    var clones = [clone];
    var ca = clone.querySelectorAll('*');
    for (var i = 0; i < ca.length; i++) clones.push(ca[i]);
    for (var k = 0; k < originals.length; k++) {
      var orig = originals[k], target = clones[k];
      if (!(orig instanceof Element) || !target || !('style' in target)) continue;
      target.style.cssText = buildComputedCSS(orig, customPropNames);
      target.setAttribute('data-magic-id', String(k));
    }
    return clone.outerHTML;
  }
`

export function buildDevtoolsEvalSnippet(states: string[]): string {
  return `(() => {
  ${serializerBody}
  if (typeof $0 === "undefined" || $0 === null) {
    return { __magicCopyError: "No element selected in the Elements panel." };
  }
  try {
    var customPropNames = collectCustomPropNames();
    var overrideRules   = buildOverrideMap(${JSON.stringify(states)});
    var pageBg          = getPageBackground();
    var schemeCSS       = extractColorSchemeCSS();
    var liveCSS         = buildRootVarsCSS(customPropNames)
                        + extractFontFaceCSS()
                        + extractKeyframesCSS()
                        + buildLivePseudoCSS($0);
    return {
      frozen:         serializeFrozen($0, overrideRules),
      liveHTML:       serializeLive($0, customPropNames),
      liveCSS:        liveCSS,
      forcedStateCSS: buildForcedStateMap($0),
      pageBackground: pageBg.color,
      isDark:         pageBg.isDark,
      schemeCSS:      schemeCSS
    };
  } catch(e) {
    return { __magicCopyError: String((e && e.message) || e) };
  }
})()`
}

export const devtoolsEvalSnippet = buildDevtoolsEvalSnippet([])
