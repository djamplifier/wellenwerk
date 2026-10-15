"""Server-Teil der Beispiel-Erweiterung: eigene API-Route und ein Ereignis-Hook."""
import json


def setup(ww):
    datei = ww.data_dir / "zaehler.json"
    stand = {"n": json.loads(datei.read_text()).get("n", 0) if datei.exists() else 0}

    @ww.router.get("/hallo")
    async def hallo():
        st = ww.station()
        return {"gruss": ww.settings().get("gruss"), "rufzeichen": st["callsign"], "locator": st["locator"], "qsos": stand["n"]}

    async def neues_qso(msg):
        if not ww.settings().get("zaehlen"):
            return
        stand["n"] += 1
        datei.write_text(json.dumps(stand))
        await ww.broadcast({"type": "beispiel_zaehler", "n": stand["n"], "call": msg.get("qso", {}).get("call")})

    ww.on("qso", neues_qso)
    ww.log.info("Beispiel-Erweiterung bereit")
