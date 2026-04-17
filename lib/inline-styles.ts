// ─── Content-script typed implementation ─────────────────────────────────────
// The right-click path captures whatever state is visually active at that
// moment (getComputedStyle is live), so no extra pseudo-state logic needed.

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
// Runs inside chrome.devtools.inspectedWindow.eval — the full live page DOM
// is available, including document.styleSheets, getComputedStyle, and $0.
//
// Returns { frozen, liveHTML, liveCSS } or { __magicCopyError }.
//
//  frozen   — every element has ALL computed standard properties + resolved
//             pseudo-state overrides inlined as style="…".  Self-contained.
//             Sent to the clipboard.
//
//  liveHTML — every element has ALL computed standard properties + ALL resolved
//             CSS custom properties inlined, PLUS a data-magic-id="N" attribute
//             that the liveCSS rules reference.  Sent to the preview iframe.
//
//  liveCSS  — reconstructed CSS that makes hover/focus/… work live:
//               1. :root { --var: <resolved> }  for every custom property
//               2. @font-face rules so the right font loads in the iframe
//               3. [data-magic-id="N"]:hover { … !important }
//                  Where N is the element that TRIGGERS the state, and an
//                  optional descendant selector like
//                  [data-magic-id="P"]:hover [data-magic-id="C"] { … }
//                  is used when the ancestor that triggers :hover is a
//                  different element from the one that changes visually.
//
// ── Pseudo-state simulation strategy ─────────────────────────────────────────
//
// 1. Walk document.styleSheets recursively (into @media / @supports).
// 2. Collect every rule whose selector contains a target pseudo-class.
//    Store: original selector, base selector (pseudo stripped), which states
//    were present, and the rule's explicit property declarations.
// 3. frozen: inline getComputedStyle for every element, then overlay any
//    matching rule's explicit props on top (covers ancestor-triggered rules
//    like .nav:hover .link because we run in the full page DOM context).
// 4. liveCSS: assign data-magic-id=N to every element (N = index in tree).
//    For each rule matching element N, detect which ancestor M (also in tree)
//    carries the :hover/:focus/… via findAnchorIndex.
//    Emit [data-magic-id="M"]:state [data-magic-id="N"] { … !important }
//    or [data-magic-id="N"]:state { … } if M == N (direct target).
//    Because custom properties in the rule's declarations may use var(--x),
//    and those variables exist in the real page but not the iframe, we resolve
//    them: the full set of custom properties is inlined on each element in
//    liveHTML, and :root { } in liveCSS covers the global tokens.

const serializerBody = `
  // ── Utility: walk rule lists recursively ─────────────────────────────────
  function eachRule(ruleList, fn) {
    for (var i = 0; i < ruleList.length; i++) {
      var r = ruleList[i];
      if (r.cssRules) { eachRule(r.cssRules, fn); } else { fn(r); }
    }
  }

  function allSheetRules(fn) {
    for (var si = 0; si < document.styleSheets.length; si++) {
      try { eachRule(document.styleSheets[si].cssRules, fn); } catch(e) {}
    }
  }

  // ── 1. Root-level CSS custom properties ──────────────────────────────────
  function buildRootVarsCSS() {
    var names = Object.create(null);
    allSheetRules(function(r) {
      if (!r.style) return;
      for (var pi = 0; pi < r.style.length; pi++) {
        var p = r.style[pi].trim();
        if (p.indexOf('--') === 0) names[p] = 1;
      }
    });
    var root = getComputedStyle(document.documentElement);
    var css = ':root{';
    for (var p in names) {
      var v = root.getPropertyValue(p).trim();
      if (v) css += p + ':' + v + ';';
    }
    return css + '}';
  }

  // ── 2. @font-face rules ───────────────────────────────────────────────────
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

  // ── 3. Pseudo-state rule collection ──────────────────────────────────────
  function buildOverrideMap(activeStates) {
    if (!activeStates || !activeStates.length) return [];
    var sorted = activeStates.slice().sort(function(a, b) { return b.length - a.length; });
    // No escaping needed — hyphens in group alternation are literal.
    var regex = new RegExp(':(' + sorted.join('|') + ')', 'gi');
    var rules = [];
    allSheetRules(function(rule) {
      if (!rule.selectorText || !rule.style) return;
      regex.lastIndex = 0;
      if (!regex.test(rule.selectorText)) { regex.lastIndex = 0; return; }
      regex.lastIndex = 0;
      rule.selectorText.split(',').forEach(function(part) {
        var original = part.trim();
        var found = [];
        for (var ai = 0; ai < activeStates.length; ai++) {
          if (original.indexOf(':' + activeStates[ai]) !== -1) found.push(activeStates[ai]);
        }
        if (!found.length) return;
        var base = original.replace(regex, '').trim() || '*';
        var props = Object.create(null);
        for (var pi = 0; pi < rule.style.length; pi++) {
          var p = rule.style[pi];
          props[p] = rule.style.getPropertyValue(p);
        }
        rules.push({ original: original, base: base, states: found, props: props });
      });
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

  // ── 4. Anchor detection for ancestor-triggered states ─────────────────────
  // Given ".nav:hover .link" (original), state="hover", and targetEl = .link,
  // returns the index in originals of the element that carries :hover (.nav).
  // Returns -1 if the anchor is outside the captured subtree.
  function findAnchorIndex(targetEl, original, state, originals) {
    var marker = ':' + state;
    var idx = original.indexOf(marker);
    if (idx === -1) return -1;
    // Extract the compound selector that carries the pseudo-class
    var before = original.substring(0, idx);
    var segments = before.split(/[\\s>+~]+/);
    var anchorSel = segments[segments.length - 1];
    if (!anchorSel || anchorSel === '*') return -1;
    for (var i = 0; i < originals.length; i++) {
      if (originals[i] === targetEl) continue;
      try {
        if (originals[i].contains && originals[i].contains(targetEl) &&
            originals[i].matches && originals[i].matches(anchorSel)) {
          return i;
        }
      } catch(e) {}
    }
    return -1;
  }

  // ── 5. Tree helpers ───────────────────────────────────────────────────────
  function gatherTree(root) {
    var originals = [root];
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) originals.push(all[i]);
    return originals;
  }

  // Inline all computed standard properties + all known CSS custom properties.
  // customPropNames must be pre-computed to avoid redundant stylesheet scans.
  function buildComputedCSS(el, customPropNames) {
    var computed = getComputedStyle(el);
    var css = '';
    for (var j = 0; j < computed.length; j++) {
      var p = computed[j];
      css += p + ':' + computed.getPropertyValue(p) + ';';
    }
    // Inline custom properties with their RESOLVED value for this element
    // (getPropertyValue resolves inheritance, so .btn correctly gets --btn-bg
    //  even if it was defined on a parent .card).
    for (var ci = 0; ci < customPropNames.length; ci++) {
      var cp = customPropNames[ci];
      var cv = computed.getPropertyValue(cp).trim();
      if (cv) css += cp + ':' + cv + ';';
    }
    return css;
  }

  // ── 6. Serializers ────────────────────────────────────────────────────────

  // FROZEN: sent to clipboard. Base computed + pseudo overrides inlined.
  // No data-magic-id. Fully self-contained, no external deps.
  function serializeFrozen(root, overrideRules) {
    var originals = gatherTree(root);
    var clone = root.cloneNode(true);
    var clones = [clone];
    var ca = clone.querySelectorAll('*');
    for (var i = 0; i < ca.length; i++) clones.push(ca[i]);

    for (var k = 0; k < originals.length; k++) {
      var orig = originals[k], target = clones[k];
      if (!(orig instanceof Element) || !target || !('style' in target)) continue;
      var computed = getComputedStyle(orig);
      var css = '';
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

  // LIVE: sent to preview iframe alongside liveCSS.
  // Has data-magic-id="N" + base computed + resolved custom props inlined.
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
    return { html: clone.outerHTML, originals: originals };
  }

  // LIVE CSS: state-aware rules using data-magic-id selectors.
  function buildLiveCSS(originals, overrideRules, preamble) {
    var css = preamble || '';
    var seen = Object.create(null);

    for (var ri = 0; ri < overrideRules.length; ri++) {
      var rule = overrideRules[ri];
      var decls = '';
      for (var dp in rule.props) decls += dp + ':' + rule.props[dp] + ' !important;';
      if (!decls) continue;

      for (var ni = 0; ni < originals.length; ni++) {
        try { if (!originals[ni].matches || !originals[ni].matches(rule.base)) continue; }
        catch(e) { continue; }

        for (var si = 0; si < rule.states.length; si++) {
          var state = rule.states[si];
          var anchorIdx = findAnchorIndex(originals[ni], rule.original, state, originals);
          var sel;
          if (anchorIdx >= 0) {
            // e.g. .card:hover .title → [data-magic-id="CARD"]:hover [data-magic-id="TITLE"]
            sel = '[data-magic-id="' + anchorIdx + '"]:' + state +
                  ' [data-magic-id="' + ni + '"]';
          } else {
            // Direct: .btn:hover → [data-magic-id="BTN"]:hover
            sel = '[data-magic-id="' + ni + '"]:' + state;
          }
          var entry = sel + '{' + decls + '}';
          if (!seen[entry]) { css += entry; seen[entry] = 1; }
        }
      }
    }
    return css;
  }
`

export function buildDevtoolsEvalSnippet(states: string[]): string {
  return `(() => {
  ${serializerBody}
  if (typeof $0 === "undefined" || $0 === null) {
    return { __magicCopyError: "No element selected in the Elements panel." };
  }
  try {
    // Collect all known custom property names once (expensive, do it once)
    var customPropNames = [];
    (function() {
      var names = Object.create(null);
      allSheetRules(function(r) {
        if (!r.style) return;
        for (var pi = 0; pi < r.style.length; pi++) {
          var p = r.style[pi].trim();
          if (p.indexOf('--') === 0) names[p] = 1;
        }
      });
      for (var n in names) customPropNames.push(n);
    })();

    var overrideRules = buildOverrideMap(${JSON.stringify(states)});
    var preamble = buildRootVarsCSS() + extractFontFaceCSS();
    var liveData = serializeLive($0, customPropNames);
    var liveCSS = buildLiveCSS(liveData.originals, overrideRules, preamble);
    var frozen = serializeFrozen($0, overrideRules);
    return { frozen: frozen, liveHTML: liveData.html, liveCSS: liveCSS };
  } catch (e) {
    return { __magicCopyError: String((e && e.message) || e) };
  }
})()`
}

export const devtoolsEvalSnippet = buildDevtoolsEvalSnippet([])
