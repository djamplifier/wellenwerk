"""Programmpaket bauen: python packaging/build.py  ->  dist/Wellenwerk/ (Ordner mit Programmdatei).

Liegt vorher ein Hamlib-Ordner unter packaging/hamlib (mit bin/rigctld[.exe], rotctld, rigctl, rotctl und DLLs),
wird er mitgeliefert; sonst nutzt Wellenwerk das Hamlib des Systems."""
import os
import sys
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent.parent
sep = os.pathsep
args = [
    str(ROOT / "packaging" / "run_wellenwerk.py"),
    "--name", "Wellenwerk", "--noconfirm", "--clean", "--onedir", "--console",
    "--paths", str(ROOT),
    "--add-data", f"{ROOT / 'static'}{sep}static",
    "--collect-submodules", "uvicorn", "--collect-submodules", "wellenwerk",
    "--hidden-import", "serial.tools.list_ports",
    "--distpath", str(ROOT / "dist"), "--workpath", str(ROOT / "build"), "--specpath", str(ROOT / "build"),
]
if (ROOT / "docs").is_dir() and any((ROOT / "docs").iterdir()):
    args += ["--add-data", f"{ROOT / 'docs'}{sep}docs"]
ham = ROOT / "packaging" / "hamlib"
if ham.is_dir():
    args += ["--add-data", f"{ham}{sep}hamlib"]
icon = ROOT / "static" / ("icon.ico" if sys.platform == "win32" else "icon.png")
if icon.exists() and sys.platform == "win32":
    args += ["--icon", str(icon)]
PyInstaller.__main__.run(args)
