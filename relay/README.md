# Annahmestelle für Rückmeldungen

Cloudflare Worker, der Rückmeldungen und (mit Zustimmung) automatische Fehlerberichte aus Wellenwerk annimmt.
Die GitHub-Action `.github/workflows/meldungen.yml` holt sie alle 15 Minuten ab und legt daraus Issues an –
der Worker selbst kennt keinen GitHub-Schlüssel.

- `POST /report` – Meldung aus dem Programm (Begrenzung je Absender und Tag, gleiche automatische Fehler werden gezählt)
- `GET /pending`, `POST /ack` – nur für die Action (`Authorization: Bearer <PULL_TOKEN>`)

Einrichten: KV-Namensraum anlegen (`wrangler kv namespace create REPORTS`, ID in `wrangler.toml`),
`wrangler secret put PULL_TOKEN`, `wrangler deploy`. Im Repo: Variable `MELDUNGEN_URL` (Adresse des Workers)
und Geheimnis `MELDUNGEN_TOKEN` (= PULL_TOKEN). Lokal testen: `.dev.vars` mit `PULL_TOKEN=…`, dann `wrangler dev`.
