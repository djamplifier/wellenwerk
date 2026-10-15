"""Empfaenger-Arten. Neue Arten (auch aus Erweiterungen) melden sich mit register() an."""
from .kiwi import KiwiRig
from .openwebrx import OpenWebRXRig

TYPES = {"kiwisdr": dict(cls=KiwiRig, label="KiwiSDR", needs="url"), "openwebrx": dict(cls=OpenWebRXRig, label="OpenWebRX", needs="url")}


def register(kind: str, cls, label: str, needs: str = "url"):
    TYPES[kind] = dict(cls=cls, label=label, needs=needs)


def rig_class(kind: str):
    if kind not in TYPES:
        raise RuntimeError(f"Empfänger-Art „{kind}“ wird nicht unterstützt")
    return TYPES[kind]["cls"]


def kinds() -> list[dict]:
    return [dict(kind=k, label=v["label"], needs=v["needs"]) for k, v in TYPES.items()]
