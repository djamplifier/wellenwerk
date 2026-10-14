"""Diplom-Auswertung: DXCC, WAZ, WAS, WPX, WAC, DOK, IOTA - gearbeitet und bestaetigt."""
import re

US_DXCC = {291, 6, 110}           # USA, Alaska, Hawaii
US_STATES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC "
             "ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split()
CONTINENTS = {"AF": "Afrika", "AN": "Antarktis", "AS": "Asien", "EU": "Europa", "NA": "Nordamerika",
              "OC": "Ozeanien", "SA": "Südamerika"}
AWARD_BANDS = ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m", "70cm"]
PHONE = {"SSB", "USB", "LSB", "AM", "FM", "DIGITALVOICE"}


def mode_class(mode: str) -> str:
    m = (mode or "").upper()
    if m in ("CW",):
        return "CW"
    if m in PHONE:
        return "Phone"
    return "Digital" if m else ""


def confirmed(q: dict, eqsl_counts: bool = False) -> bool:
    if (q.get("qsl_rcvd") or "").upper() in ("Y", "V") or (q.get("lotw_qsl_rcvd") or "").upper() in ("Y", "V"):
        return True
    return eqsl_counts and (q.get("eqsl_qsl_rcvd") or "").upper() in ("Y", "V")


def wpx_prefix(call: str) -> str:
    """WPX-Praefix nach CQ-Regeln (vereinfacht): DL1ABC->DL1, WB8XYZ->WB8, PA/DL1ABC->PA0, DL1ABC/3->DL3."""
    parts = [p for p in call.upper().split("/") if p]
    if not parts:
        return ""
    suffixes = {"P", "M", "MM", "AM", "QRP", "A", "B", "LH", "R"}
    core = [p for p in parts if p not in suffixes]
    if not core:
        return ""
    main = max(core, key=len)
    digit = next((p for p in core if p.isdigit() and len(p) == 1), None)
    pre = next((p for p in core if p is not main and not p.isdigit()), None)
    if pre:                                          # PA/DL1ABC -> PA0, 3D2/... -> 3D2
        return pre if re.search(r"\d$", pre) else pre + "0"
    m = re.match(r"^([A-Z0-9]*?\d+)", main)
    if not m:
        return main[:2] + "0"
    p = m.group(1)
    if digit:                                        # DL1ABC/3 -> DL3
        p = re.sub(r"\d+$", digit, p)
    return p


def compute(qsos: list[dict], cty_names: dict[int, str], eqsl_counts: bool = False) -> dict:
    def new():
        return {"worked": set(), "confirmed": set()}
    dxcc, dxcc_band, dxcc_mode = new(), {}, {}
    waz, was, wpx, wac, dok, iota = new(), new(), new(), new(), new(), new()
    for q in qsos:
        c = confirmed(q, eqsl_counts)
        band, mc = (q.get("band") or "").lower(), mode_class(q.get("mode"))

        def add(bucket, key):
            if key in (None, ""):
                return
            bucket["worked"].add(key)
            if c:
                bucket["confirmed"].add(key)
        dx = q.get("dxcc")
        add(dxcc, dx)
        if dx and band:
            add(dxcc_band.setdefault(band, new()), dx)
        if dx and mc:
            add(dxcc_mode.setdefault(mc, new()), dx)
        add(waz, q.get("cqz"))
        if dx in US_DXCC and (q.get("state") or "").upper() in US_STATES:
            add(was, q["state"].upper())
        add(wpx, q.get("pfx") or wpx_prefix(q.get("call", "")))
        add(wac, q.get("cont"))
        if dx == 230 and q.get("darc_dok"):
            add(dok, q["darc_dok"].upper())
        add(iota, (q.get("iota") or "").upper() or None)

    def summary(b, total=None):
        return dict(worked=len(b["worked"]), confirmed=len(b["confirmed"]), total=total)

    # DXCC-Matrix: je Land die Baender mit W(orked)/C(onfirmed)
    matrix = {}
    for band, b in dxcc_band.items():
        for dx in b["worked"]:
            matrix.setdefault(dx, {})[band] = "C" if dx in b["confirmed"] else "W"
    for mc, b in dxcc_mode.items():
        for dx in b["worked"]:
            matrix.setdefault(dx, {})[mc] = "C" if dx in b["confirmed"] else "W"
    rows = sorted(({"dxcc": dx, "country": cty_names.get(dx, str(dx)), "cells": cells,
                    "confirmed": dx in dxcc["confirmed"]} for dx, cells in matrix.items()),
                  key=lambda r: r["country"])
    return dict(
        dxcc=summary(dxcc, 340), waz=summary(waz, 40), was=summary(was, 50), wpx=summary(wpx), wac=summary(wac, 6),
        dok=summary(dok), iota=summary(iota),
        dxcc_bands={b: summary(dxcc_band[b]) for b in AWARD_BANDS if b in dxcc_band},
        dxcc_modes={m: summary(v) for m, v in dxcc_mode.items()},
        matrix=rows, bands=[b for b in AWARD_BANDS if b in dxcc_band], modes=[m for m in ("CW", "Phone", "Digital") if m in dxcc_mode],
        waz_list=[dict(zone=z, worked=z in waz["worked"], confirmed=z in waz["confirmed"]) for z in range(1, 41)],
        was_list=[dict(state=s, worked=s in was["worked"], confirmed=s in was["confirmed"]) for s in US_STATES],
        wac_list=[dict(cont=k, name=v, worked=k in wac["worked"], confirmed=k in wac["confirmed"])
                  for k, v in CONTINENTS.items() if k != "AN"],
        dok_list=sorted(dok["worked"]), iota_list=sorted(iota["worked"]),
    )
