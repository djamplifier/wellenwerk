// Holt Rueckmeldungen und Fehlerberichte bei der Annahmestelle (relay/worker.js) ab und legt GitHub-Issues an.
// Aufruf aus .github/workflows/meldungen.yml ueber actions/github-script: module.exports({ github, context, core, url, token }).
const LABELS = { Problem: ["fehlerbericht"], Vorschlag: ["vorschlag"], Frage: ["frage"], Lob: ["lob"], Sonstiges: ["rueckmeldung"], Fehlerbericht: ["fehlerbericht", "automatisch"] };
const COLORS = { fehlerbericht: "d73a4a", vorschlag: "a2eeef", frage: "d876e3", lob: "0e8a16", rueckmeldung: "c5def5", automatisch: "fbca04", "aus-dem-programm": "1d76db" };

module.exports = async ({ github, context, core, url, token, fetchFn = fetch }) => {
  const { owner, repo } = context.repo;
  const H = { Authorization: `Bearer ${token}` };
  const r = await fetchFn(`${url}/pending`, { headers: H });
  if (!r.ok) throw new Error(`Annahmestelle: ${r.status}`);
  const { reports = [], repeats = {} } = await r.json();
  core.info(`${reports.length} neue Meldungen, ${Object.keys(repeats).length} wiederholte Fehler`);
  if (!reports.length && !Object.keys(repeats).length) return;
  for (const [name, color] of Object.entries(COLORS)) {
    try { await github.rest.issues.createLabel({ owner, repo, name, color }); } catch { /* gibt es schon */ }
  }
  const findSig = async sig => {
    const q = `repo:${owner}/${repo} is:issue in:body "Kennung: ${sig}"`;
    const res = await github.rest.search.issuesAndPullRequests({ q, per_page: 1 });
    return res.data.items[0];
  };
  const done = [], sigsDone = [];
  for (const m of reports) {
    try {
      const old = m.auto && m.sig ? await findSig(m.sig) : null;
      if (old) {
        await github.rest.issues.createComment({ owner, repo, issue_number: old.number, body: `Erneut aufgetreten (Version ${m.version || "?"}, ${m.at}).` });
      } else {
        const body = [`**Art:** ${m.kind} · **Version:** ${m.version || "?"} · **Eingegangen:** ${m.at}${m.auto ? " · automatisch gemeldet" : ""}`, "",
          "```text", m.text.replace(/```/g, "ˋˋˋ"), "```", "", m.sig ? `Kennung: ${m.sig}` : "", "_Über das Programm gemeldet._"].join("\n");
        await github.rest.issues.create({ owner, repo, title: m.title, body, labels: [...(LABELS[m.kind] || ["rueckmeldung"]), "aus-dem-programm"] });
      }
      done.push(m.key);
    } catch (e) { core.warning(`Meldung ${m.key}: ${e.message}`); }
  }
  for (const [sig, n] of Object.entries(repeats)) {
    try {
      const old = await findSig(sig);
      if (old) await github.rest.issues.createComment({ owner, repo, issue_number: old.number, body: `Seit der letzten Meldung ${n}× erneut aufgetreten.` });
      sigsDone.push(sig);
    } catch (e) { core.warning(`Wiederholung ${sig}: ${e.message}`); }
  }
  await fetchFn(`${url}/ack`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ keys: done, sigs: sigsDone }) });
  core.info(`${done.length} Issues angelegt/ergänzt`);
};
