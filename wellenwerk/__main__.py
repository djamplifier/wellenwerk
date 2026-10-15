"""Wellenwerk starten (Einzelplatz): python -m wellenwerk  bzw. Doppelklick auf die Programmdatei.

Startet den Server auf diesem Rechner und oeffnet den Browser. Daten liegen im Benutzerordner
(Windows: %APPDATA%\\Wellenwerk, macOS: ~/Library/Application Support/Wellenwerk, Linux: ~/.local/share/wellenwerk).
Ueber http://localhost darf der Browser auch ohne Zertifikat auf die Soundkarte zugreifen (Digitalmodi)."""
import argparse
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path


def data_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Wellenwerk"
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "Wellenwerk"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "wellenwerk"
    base.mkdir(parents=True, exist_ok=True)
    return base


def free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def main():
    if "--mcp" in sys.argv:            # MCP-Server fuer KI-Assistenten (stdio), braucht ein laufendes Wellenwerk
        from wellenwerk.mcp import main as mcp_main
        return mcp_main([x for x in sys.argv[1:] if x != "--mcp"])
    ap = argparse.ArgumentParser(prog="wellenwerk", description="Wellenwerk – Stationssteuerung und Logbuch")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--lan", action="store_true", help="auch aus dem Heimnetz erreichbar (sonst nur dieser Rechner)")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--data", help="Datenordner")
    ap.add_argument("--desktop", action="store_true", help="vom Desktop-Programm gestartet (kein Browser, Beenden ueber /api/shutdown)")
    a = ap.parse_args()
    os.environ.setdefault("WW_DATA", a.data or str(data_dir()))
    if a.desktop:
        os.environ["WW_DESKTOP"] = "1"
        a.no_browser = True
    url = f"http://localhost:{a.port}/"
    if not free(a.port):
        print(f"Wellenwerk läuft bereits: {url}")
        if not a.no_browser:
            webbrowser.open(url)
        return
    if not a.no_browser:
        threading.Thread(target=lambda: (time.sleep(2.5), webbrowser.open(url)), daemon=True).start()
    print(f"Wellenwerk: {url}  (Daten: {os.environ['WW_DATA']})  – Fenster offen lassen, Strg+C beendet.")
    import uvicorn
    from wellenwerk.main import app
    server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0" if a.lan else "127.0.0.1", port=a.port, log_level="warning"))
    app.state.server = server          # fuer /api/shutdown (Desktop-Programm beendet den Dienst sauber)
    server.run()


if __name__ == "__main__":
    main()
