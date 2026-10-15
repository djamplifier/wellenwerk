"""Erweiterungen (Plugins). Jede Erweiterung ist ein Ordner unter <Datenordner>/plugins/<id>/ mit manifest.json:

{ "id": "beispiel", "name": "Beispiel", "version": "1.0", "author": "…", "description": "…",
  "frontend": "plugin.js",            optional: Oberflaechen-Teil (JavaScript)
  "backend": "plugin.py",             optional: Server-Teil (Python, Funktion setup(ww))
  "settings": [ {"key": "farbe", "label": "Farbe", "type": "select", "options": ["rot", "blau"], "default": "rot"} ] }

Einstellungs-Typen: text, password, number, bool, select. Erweiterungen sind standardmaessig aus und haben, einmal
eingeschaltet, dieselben Rechte wie Wellenwerk selbst."""
import asyncio
import importlib.util
import io
import json
import logging
import re
import shutil
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

from fastapi import APIRouter

log = logging.getLogger("ww.plugins")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{1,40}$")


class PluginError(RuntimeError):
    pass


class PluginAPI:
    """Was ein Server-Teil in setup(ww) bekommt."""

    def __init__(self, host: "PluginHost", pid: str):
        self._h, self.id = host, pid
        self.router = APIRouter(prefix=f"/api/plugins/{pid}", tags=[f"Erweiterung {pid}"])
        self.data_dir = host.root / pid / "daten"
        self.data_dir.mkdir(exist_ok=True)
        self.log = logging.getLogger(f"ww.plugin.{pid}")

    def on(self, event: str, fn):
        """Ereignis abonnieren: 'rig', 'qso', 'spot', 'station_identity', 'winlink', 'decode', 'radios', … oder '*'."""
        self._h.hooks[event].append((self.id, fn))

    def station(self) -> dict:
        return self._h.ctx["station"]()

    def settings(self) -> dict:
        return self._h.plugin_settings(self.id)

    def program_settings(self) -> dict:
        return self._h.ctx["public_cfg"]()

    async def broadcast(self, msg: dict):
        await self._h.ctx["broadcast"](dict(msg, plugin=self.id))

    @property
    def rig(self):
        return self._h.ctx["rig"]

    @property
    def radios(self):
        return self._h.ctx["radios"]

    async def log_qso(self, rec: dict) -> dict:
        return await self._h.ctx["log_qso"](rec, f"Erweiterung {self.id}")

    def register_receiver(self, kind: str, cls, label: str, needs: str = "url"):
        from .sdr import registry
        registry.register(kind, cls, label, needs)


class PluginHost:
    def __init__(self, root: Path, cfg: dict, ctx: dict):
        self.root, self.cfg, self.ctx = root, cfg, ctx
        root.mkdir(parents=True, exist_ok=True)
        self.hooks: dict = defaultdict(list)
        self.loaded: dict = {}
        self.errors: dict = {}

    # ---------- Verwaltung ----------
    def manifests(self) -> list[dict]:
        out = []
        for d in sorted(self.root.iterdir()):
            mf = d / "manifest.json"
            if not mf.is_file():
                continue
            try:
                m = json.loads(mf.read_text(encoding="utf-8"))
            except ValueError as e:
                out.append(dict(id=d.name, name=d.name, error=f"manifest.json unlesbar: {e}"))
                continue
            m["id"] = d.name
            out.append(m)
        return out

    def _state(self) -> dict:
        return self.cfg.setdefault("plugins", {})

    def plugin_settings(self, pid: str) -> dict:
        m = next((x for x in self.manifests() if x["id"] == pid), {})
        vals = dict(self._state().get(pid, {}).get("settings", {}))
        for s in m.get("settings") or []:
            vals.setdefault(s["key"], s.get("default"))
        return vals

    def listing(self) -> list[dict]:
        st = self._state()
        res = []
        for m in self.manifests():
            pid = m["id"]
            secrets = {s["key"] for s in m.get("settings") or [] if s.get("type") == "password"}
            vals = {k: ("••••••" if k in secrets and v else v) for k, v in self.plugin_settings(pid).items()}
            res.append(dict(m, enabled=bool(st.get(pid, {}).get("enabled")), values=vals, loaded=pid in self.loaded,
                            error=m.get("error") or self.errors.get(pid, "")))
        return res

    def install_zip(self, data: bytes) -> str:
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            raise PluginError("keine gültige ZIP-Datei")
        names = z.namelist()
        mf = next((n for n in names if n.endswith("manifest.json") and n.count("/") <= 1), None)
        if not mf:
            raise PluginError("manifest.json fehlt im ZIP")
        prefix = mf[: -len("manifest.json")]
        m = json.loads(z.read(mf))
        pid = str(m.get("id") or "").lower()
        if not ID_RE.match(pid):
            raise PluginError("ungültige id im Manifest (a–z, 0–9, - und _)")
        dest = self.root / pid
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir()
        for n in names:
            if not n.startswith(prefix) or n.endswith("/"):
                continue
            rel = Path(n[len(prefix):])
            if rel.is_absolute() or ".." in rel.parts:
                raise PluginError("unzulässiger Pfad im ZIP")
            p = dest / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(z.read(n))
        return pid

    def remove(self, pid: str):
        if not ID_RE.match(pid):
            raise PluginError("ungültige id")
        shutil.rmtree(self.root / pid, ignore_errors=True)
        self._state().pop(pid, None)

    def set_state(self, pid: str, enabled: bool | None = None, settings: dict | None = None):
        st = self._state().setdefault(pid, {})
        if enabled is not None:
            st["enabled"] = bool(enabled)
        if settings is not None:
            m = next((x for x in self.manifests() if x["id"] == pid), None)
            if not m:
                raise PluginError("Erweiterung nicht gefunden")
            schema = {s["key"]: s for s in m.get("settings") or []}
            cur = st.setdefault("settings", {})
            for k, v in settings.items():
                if k not in schema or (schema[k].get("type") == "password" and v == "••••••"):
                    continue
                t = schema[k].get("type", "text")
                cur[k] = (v in (True, "true", "1", 1, "on")) if t == "bool" else (float(v) if t == "number" and v not in ("", None) else v)

    # ---------- Server-Teile laden ----------
    def load_backends(self, app):
        for m in self.manifests():
            pid = m["id"]
            if not m.get("backend") or not self._state().get(pid, {}).get("enabled") or pid in self.loaded:
                continue
            try:
                path = self.root / pid / m["backend"]
                spec = importlib.util.spec_from_file_location(f"ww_plugin_{pid.replace('-', '_')}", path)
                mod = importlib.util.module_from_spec(spec)
                sys.modules[spec.name] = mod
                spec.loader.exec_module(mod)
                api = PluginAPI(self, pid)
                if hasattr(mod, "setup"):
                    r = mod.setup(api)
                    if asyncio.iscoroutine(r):
                        asyncio.get_event_loop().create_task(r)
                app.include_router(api.router)
                self.loaded[pid] = mod
                self.errors.pop(pid, None)
                log.info("Erweiterung %s geladen", pid)
            except Exception as e:
                self.errors[pid] = f"{type(e).__name__}: {e}"
                log.exception("Erweiterung %s nicht geladen", pid)

    def unload(self, pid: str, app):
        """Server-Teil sofort abmelden: Ereignis-Hooks und API-Routen entfernen, optional teardown() aufrufen."""
        mod = self.loaded.pop(pid, None)
        for ev in list(self.hooks):
            self.hooks[ev] = [(p, f) for p, f in self.hooks[ev] if p != pid]
        prefix = f"/api/plugins/{pid}/"
        app.router.routes[:] = [r for r in app.router.routes if not getattr(r, "path", "").startswith(prefix)]
        app.openapi_schema = None
        if mod is not None and hasattr(mod, "teardown"):
            try:
                mod.teardown()
            except Exception as e:
                log.warning("Erweiterung %s: teardown: %s", pid, e)

    async def dispatch(self, msg: dict):
        """Jede Meldung an die Oberflaeche geht auch an abonnierte Server-Teile."""
        for pid, fn in self.hooks.get(msg.get("type"), []) + self.hooks.get("*", []):
            if msg.get("plugin") == pid:          # eigene Meldungen nicht zurueckspielen (keine Endlosschleifen)
                continue
            try:
                r = fn(msg)
                if asyncio.iscoroutine(r):
                    await r
            except Exception as e:
                self.errors[pid] = f"Ereignis {msg.get('type')}: {e}"
