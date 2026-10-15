"use strict";
// Wellenwerk – Mehrsprachigkeit. Die Oberflaeche ist auf Deutsch geschrieben; fuer andere Sprachen
// uebersetzt diese Schicht alle sichtbaren Texte zur Laufzeit anhand von static/i18n/<sprache>.json
// (deutscher Text → Uebersetzung). Schluessel mit {} sind Muster: {} steht fuer einen beliebigen Teil
// (Zahl, Rufzeichen …), der in der Uebersetzung an der Stelle des jeweiligen {} wieder eingesetzt wird.
// Bereiche mit translate="no" (Empfangstexte, Logbuch-Inhalte, Eingaben) bleiben unangetastet.
const I18N = (() => {
  const LANGS = { de: "Deutsch", en: "English" };
  const LOCALES = { de: "de-DE", en: "en-GB" };
  const read = k => { try { return JSON.parse(localStorage.getItem("ww." + k)); } catch { return null; } };
  const guess = () => ((navigator.language || "de").toLowerCase().startsWith("de") ? "de" : "en");
  let lang = read("lang") || read("lang.auto") || guess();   // „lang“ = im Browser gewaehlt, „lang.auto“ = von der Station uebernommen
  if (!LANGS[lang]) lang = "de";
  const exact = new Map(), patterns = [], cache = new Map();
  const norm = s => s.replace(/\s+/g, " ").trim();
  const decode = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  function add(dict) {
    for (const [k0, v0] of Object.entries(dict || {})) {
      for (const [k, v] of [[k0, v0], [decode(k0), decode(v0)]]) {
        const nk = norm(k); if (!nk || !v) continue;
        if (nk.includes("{}")) {
          const re = new RegExp("^" + nk.split("{}").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.+?)") + "$", "s");
          patterns.push({ re, v, len: nk.length });
        } else exact.set(nk, v);
      }
    }
    patterns.sort((a, b) => b.len - a.len);
    cache.clear();
  }
  function load(l) {
    if (l === "de") return;
    try {   // synchron, damit schon der erste Bildaufbau uebersetzt ist
      const x = new XMLHttpRequest(); x.open("GET", `/static/i18n/${l}.json?v=${Date.now() >> 22}`, false); x.send();
      if (x.status === 200) add(JSON.parse(x.responseText));
    } catch (e) { console.warn("i18n", e); }
  }
  load(lang);
  function lookup(n) {
    let r = exact.get(n);
    if (r !== undefined) return r;
    for (const p of patterns) {
      const m = p.re.exec(n);
      if (m) { let i = 1; return p.v.replace(/\{\}/g, () => { const part = m[i++] ?? ""; return exact.get(norm(part)) ?? part; }); }
    }
    return null;
  }
  // Uebersetzt einen Text; unbekannte Texte bleiben unveraendert. Fuehrende/abschliessende Leerzeichen bleiben erhalten.
  function t(s) {
    if (lang === "de" || s == null) return s;
    s = String(s);
    if (!/[A-Za-zÄÖÜäöüß]/.test(s)) return s;
    if (cache.has(s)) return cache.get(s);
    const n = norm(s);
    let r = lookup(n);
    if (r == null) {   // Zeichen am Rand (Sortierpfeil, Doppelpunkt, Symbol) abtrennen und den Rest suchen
      const m = /^([▶■●＋→✓⏎↻\s]*)(.*?)([\s:…▼▲⏎↻]*)$/.exec(n);
      if (m && (m[1] || m[3]) && m[2]) { const b = lookup(m[2]); if (b != null) r = m[1] + b + m[3]; }
    }
    const out = r == null ? s : s.match(/^\s*/)[0] + r + s.match(/\s*$/)[0];
    if (cache.size > 20000) cache.clear();
    cache.set(s, out);
    return out;
  }
  // ---- DOM: Texte und sichtbare Attribute uebersetzen, auch alles, was spaeter eingefuegt wird ----
  const ATTRS = ["placeholder", "title", "aria-label", "data-tip"];
  const SKIP = "script,style,textarea,code,pre,[contenteditable],[translate=no]";
  const done = new WeakMap();   // Knoten → zuletzt gesetzter Text (verhindert Endlosschleifen)
  const skip = el => !el || (el.closest && el.closest(SKIP));
  function textNode(n) {
    const v = n.nodeValue; if (done.get(n) === v) return;
    if (skip(n.parentElement)) return;
    const o = t(v); done.set(n, o); if (o !== v) n.nodeValue = o;
  }
  const noTr = el => el.closest && el.closest("[translate=no]");
  function attrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a); if (!v) continue;
      const key = "a:" + a; const m = done.get(el) || {}; if (m[key] === v) continue;
      const o = t(v); m[key] = o; done.set(el, m); if (o !== v) el.setAttribute(a, o);
    }
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/.test(el.type) && el.value) { const o = t(el.value); if (o !== el.value) el.value = o; }
  }
  function walk(root) {
    if (lang === "de" || !root) return;
    if (root.nodeType === 3) { textNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (noTr(root)) return; attrs(root); if (skip(root)) return; }
    const w = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.nodeType === 1 && n.matches(SKIP) ? (n.matches("[translate=no]") ? NodeFilter.FILTER_REJECT : (attrs(n), NodeFilter.FILTER_REJECT)) : NodeFilter.FILTER_ACCEPT });
    for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? textNode(n) : attrs(n);
  }
  function observe(doc = document) {
    if (lang === "de") return;
    walk(doc.documentElement);
    new MutationObserver(ms => {
      for (const m of ms) {
        if (m.type === "childList") m.addedNodes.forEach(walk);
        else if (m.type === "characterData") textNode(m.target);
        else if (m.type === "attributes" && !noTr(m.target)) attrs(m.target);
      }
    }).observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (lang !== "de") {
    document.documentElement.lang = lang;
    for (const f of ["alert", "confirm", "prompt"]) { const o = window[f].bind(window); window[f] = (msg, ...a) => o(t(msg), ...a); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => observe()); else observe();
  }
  return {
    get lang() { return lang; }, get locale() { return LOCALES[lang] || lang; }, languages: LANGS, t, add,
    watch(doc) { if (lang !== "de") { doc.documentElement.lang = lang; observe(doc); } },   // z. B. ausgeklinkte Fenster
    // Sprache wechseln: wird im Browser gemerkt; die Oberflaeche wird neu geladen
    set(l, reload = true, auto = false) { try { localStorage.setItem(auto ? "ww.lang.auto" : "ww.lang", JSON.stringify(l)); } catch { } if (reload && l !== lang) location.reload(); },
    chosen: () => !!read("lang"),
  };
})();
