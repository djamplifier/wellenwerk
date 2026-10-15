// Wellenwerk – Annahmestelle fuer Rueckmeldungen und Fehlerberichte (Cloudflare Worker).
// Das Programm schickt Meldungen per POST /report; eine GitHub-Action des Repos holt sie mit GET /pending ab,
// legt Issues an und bestaetigt sie mit POST /ack. Der Worker kennt keinen GitHub-Schluessel.
// Speicher: KV-Namensraum REPORTS. Geheimnis: PULL_TOKEN (nur fuer /pending und /ack).
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

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" } });
    if (u.pathname === "/report" && req.method === "POST") return report(req, env);
    if (u.pathname === "/pending" && req.method === "GET") return (await authed(req, env)) ? pending(env) : json({ error: "nicht erlaubt" }, 401);
    if (u.pathname === "/ack" && req.method === "POST") return (await authed(req, env)) ? ack(req, env) : json({ error: "nicht erlaubt" }, 401);
    if (u.pathname === "/") return json({ service: "Wellenwerk-Rückmeldungen", ok: true });
    return json({ error: "nicht gefunden" }, 404);
  },
};
