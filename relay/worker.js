// Wellenwerk – Annahmestelle fuer Rueckmeldungen und Fehlerberichte (Cloudflare Worker).
// Das Programm schickt Meldungen per POST /report; eine GitHub-Action des Repos holt sie mit GET /pending ab,
// legt Issues an und bestaetigt sie mit POST /ack. Der Worker kennt keinen GitHub-Schluessel.
// Speicher: KV-Namensraum REPORTS. Geheimnis: PULL_TOKEN (nur fuer /pending und /ack).
// Zusaetzlich: anonyme Online-Zaehlung (POST /ping, GET /online, /widget.js fuer die Seitenleiste des Blogs) im
// Durable Object PRESENCE. Gespeichert werden nur Zufalls-ID des Programms, Land (von Cloudflare), Version und Zeit – keine IP.
const MAX_BODY = 24000, PER_IP_HOUR = 6, PER_DAY = 300, KEEP = 14 * 86400;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n);

async function bump(env, key, ttl) {
  const n = +(await env.REPORTS.get(key)) || 0;
  await env.REPORTS.put(key, String(n + 1), { expirationTtl: ttl });
  return n + 1;
}

async function report(req, env) {
  const len = +(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return json({ error: "zu groß" }, 413);
  let b; try { b = JSON.parse(await req.text()); } catch { return json({ error: "ungültig" }, 400); }
  if (b.website) return json({ ok: true });                       // Honigtopf-Feld: Formular-Spam
  const kind = clean(b.kind, 30) || "Problem", text = clean(b.text, 16000).trim(), title = clean(b.title, 150).trim();
  if (text.length < 5 || !title) return json({ error: "Beschreibung fehlt" }, 400);
  if (!/^Wellenwerk/.test(clean(b.client, 40))) return json({ error: "unbekannter Absender" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "?", hour = Math.floor(Date.now() / 3600e3), day = Math.floor(Date.now() / 86400e3);
  if (await bump(env, `ip:${ip}:${hour}`, 7200) > PER_IP_HOUR) return json({ error: "zu viele Meldungen – bitte später erneut" }, 429);
  if (await bump(env, `day:${day}`, 172800) > PER_DAY) return json({ error: "Tageslimit erreicht – bitte morgen erneut" }, 429);
  const sig = clean(b.sig, 40).replace(/[^\w-]/g, "");
  if (b.auto && sig) {                                               // gleicher automatischer Fehler: nur zaehlen
    const seen = await env.REPORTS.get(`sig:${sig}`);
    if (seen) { await bump(env, `cnt:${sig}`, KEEP); return json({ ok: true, known: true }); }
    await env.REPORTS.put(`sig:${sig}`, "1", { expirationTtl: KEEP });
  }
  const r = { kind, title, text, version: clean(b.version, 30), auto: !!b.auto, sig, at: new Date().toISOString() };
  const key = `r:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
  await env.REPORTS.put(key, JSON.stringify(r), { expirationTtl: KEEP });
  return json({ ok: true, id: key.slice(2) });
}

async function authed(req, env) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return env.PULL_TOKEN && t.length >= 20 && t === env.PULL_TOKEN;
}

async function pending(env) {
  const list = await env.REPORTS.list({ prefix: "r:", limit: 50 });
  const out = [];
  for (const k of list.keys) {
    const v = await env.REPORTS.get(k.name); if (!v) continue;
    const r = JSON.parse(v);
    out.push({ key: k.name, ...r });
  }
  const sigs = {};                                                   // Zaehler fuer schon gemeldete automatische Fehler
  for (const k of (await env.REPORTS.list({ prefix: "cnt:", limit: 100 })).keys) sigs[k.name.slice(4)] = +(await env.REPORTS.get(k.name)) || 0;
  return json({ reports: out, repeats: sigs });
}

async function ack(req, env) {
  const b = await req.json().catch(() => ({}));
  for (const k of (b.keys || []).slice(0, 100)) if (/^r:/.test(k)) await env.REPORTS.delete(k);
  for (const s of (b.sigs || []).slice(0, 100)) await env.REPORTS.delete(`cnt:${s}`);
  return json({ ok: true });
}

// ---------- Online-Zaehlung ----------
const ONLINE_TTL = 25 * 60e3;                 // Programme melden sich alle 10 min; nach 25 min ohne Meldung gelten sie als offline

export class Presence {
  constructor(state) { this.st = state; this.cache = null; }
  async fetch(req) {
    const u = new URL(req.url), now = Date.now();
    if (u.pathname === "/ping") {
      const b = await req.json().catch(() => ({}));
      await this.st.storage.put(b.id, { c: b.c, v: b.v, t: now });
      if (!(await this.st.storage.getAlarm())) await this.st.storage.setAlarm(now + ONLINE_TTL);
      this.cache = null; return json({ ok: true });
    }
    if (u.pathname === "/bye") { const b = await req.json().catch(() => ({})); await this.st.storage.delete(b.id); this.cache = null; return json({ ok: true }); }
    if (u.pathname === "/online") {
      if (this.cache && now - this.cache.at < 60e3) return json(this.cache);
      const all = await this.st.storage.list(), by = {}, vers = {}; let total = 0;
      for (const [, e] of all) { if (now - e.t > ONLINE_TTL) continue; total++; by[e.c || "XX"] = (by[e.c || "XX"] || 0) + 1; vers[e.v || "?"] = (vers[e.v || "?"] || 0) + 1; }
      this.cache = { total, countries: Object.entries(by).map(([c, n]) => ({ c, n })).sort((a, b) => b.n - a.n || a.c.localeCompare(b.c)), versions: vers, at: now };
      return json(this.cache);
    }
    return json({ error: "nicht gefunden" }, 404);
  }
  async alarm() {                              // Alte Eintraege loeschen
    const now = Date.now(), old = [];
    for (const [k, e] of await this.st.storage.list()) if (now - e.t > ONLINE_TTL) old.push(k);
    for (let i = 0; i < old.length; i += 128) await this.st.storage.delete(old.slice(i, i + 128));
    if ((await this.st.storage.list({ limit: 1 })).size) await this.st.storage.setAlarm(now + ONLINE_TTL);
  }
}
const presence = env => env.PRESENCE.get(env.PRESENCE.idFromName("weltweit"));

async function ping(req, env, path) {
  if (+(req.headers.get("content-length") || 0) > 500) return json({ error: "zu groß" }, 413);
  const b = await req.json().catch(() => ({}));
  const id = clean(b.id, 40);
  if (!/^[0-9a-f]{16,40}$/.test(id) || !/^Wellenwerk/.test(clean(b.client, 40))) return json({ error: "ungültig" }, 400);
  const c = /^[A-Z]{2}$/.test(req.cf?.country || "") ? req.cf.country : "XX";
  return presence(env).fetch("https://do" + path, { method: "POST", body: JSON.stringify({ id, c, v: clean(b.version, 20) }) });
}

async function online(env) {
  const r = await presence(env).fetch("https://do/online");
  return new Response(r.body, { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=60" } });
}

// Seitenleisten-Widget: <div id="ww-online"></div><script src="…/widget.js" async></script>
const WIDGET = `(function(){
var API=(document.currentScript&&document.currentScript.src||"").split("/widget.js")[0];
var el=document.getElementById("ww-online");if(!el){el=document.createElement("div");el.id="ww-online";(document.currentScript||document.body).insertAdjacentElement("beforebegin",el);}
var en=(el.getAttribute("data-lang")||document.documentElement.lang||"de").slice(0,2)!=="de";
var names;try{names=new Intl.DisplayNames([en?"en":"de"],{type:"region"});}catch(e){}
var flag=function(c){return c==="XX"?"\uD83C\uDF10":String.fromCodePoint.apply(null,c.split("").map(function(x){return 0x1F1A5+x.charCodeAt(0);}));};
var esc=function(s){return String(s).replace(/[&<>"]/g,function(x){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[x];});};
function draw(d){var t=d.total||0,rows=(d.countries||[]).map(function(x){var n=x.c==="XX"?(en?"unknown":"unbekannt"):(names?names.of(x.c):x.c);
return '<li style="display:flex;justify-content:space-between;gap:8px;padding:2px 0"><span>'+flag(x.c)+' '+esc(n)+'</span><b>'+x.n+'</b></li>';}).join("");
el.innerHTML='<div style="font:inherit;line-height:1.4"><div style="font-size:1.05em;margin-bottom:4px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:'+(t?'#2ecc71':'#999')+';margin-right:6px"></span><b>'+t+'</b> '+(en?(t===1?"user":"users")+" online":(t===1?"Nutzer":"Nutzer")+" online")+'</div>'
+(rows?'<ul style="list-style:none;margin:0;padding:0">'+rows+'</ul>':'')
+'<div style="font-size:.8em;opacity:.75;margin-top:4px"><a href="https://github.com/djamplifier/wellenwerk" target="_blank" rel="noopener">Wellenwerk</a> '+(en?"– free radio software · updated every minute":"– freie Funk-Software · Stand jede Minute")+'</div></div>';}
function load(){fetch(API+"/online").then(function(r){return r.json();}).then(draw).catch(function(){el.textContent=en?"Wellenwerk: no data":"Wellenwerk: keine Daten";});}
load();setInterval(load,60000);
})();`;

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
    if (u.pathname === "/ping" && req.method === "POST") return ping(req, env, "/ping");
    if (u.pathname === "/bye" && req.method === "POST") return ping(req, env, "/bye");
    if (u.pathname === "/online" && req.method === "GET") return online(env);
    if (u.pathname === "/widget.js") return new Response(WIDGET, { headers: { "content-type": "application/javascript; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=600" } });
    if (u.pathname === "/report" && req.method === "POST") return report(req, env);
    if (u.pathname === "/pending" && req.method === "GET") return (await authed(req, env)) ? pending(env) : json({ error: "nicht erlaubt" }, 401);
    if (u.pathname === "/ack" && req.method === "POST") return (await authed(req, env)) ? ack(req, env) : json({ error: "nicht erlaubt" }, 401);
    if (u.pathname === "/") return json({ service: "Wellenwerk-Rückmeldungen", ok: true });
    return json({ error: "nicht gefunden" }, 404);
  },
};
