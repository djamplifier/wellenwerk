"""Digitalfunk selbst dekodieren (Kennungen, Talkgroup, Rufzeichen) am FM-Diskriminator-Signal.

Stufe 1: DMR (ETSI TS 102 361-1) – Symbole ab jedem Synchronwort abtasten (Pegel und Polaritaet aus dem bekannten
Synchronwort geschaetzt), Burst zerlegen: CACH (Zeitschlitz), Slot Type (Colorcode, Burst-Art, Golay(20,8)),
Sprachkopf/Abschluss (BPTC(196,96) mit Hamming-Korrektur, RS(12,9)-Pruefung) -> Quelle, Ziel, Gruppen-/Einzelruf.
Ergebnis im selben Format wie die Metadaten der OpenWebRX-Dekoder, damit Anzeige, Namen und Talkgroups gleich bleiben.
"""
from __future__ import annotations

import numpy as np

from . import dvsync

DIBIT = {3: (0, 1), 1: (0, 0), -1: (1, 0), -3: (1, 1)}


def _bits_of(syms) -> list[int]:
    out = []
    for s in syms:
        out.extend(DIBIT[s])
    return out


def _num(bits) -> int:
    v = 0
    for b in bits:
        v = (v << 1) | b
    return v


# ---------- Symbole abtasten ----------
def sample_symbols(x: np.ndarray, fs: float, pos: int, sync: list[int], start: int, count: int, rate: float = 4800):
    """Symbole start..start+count (relativ zum ersten Synchron-Symbol) bei Position pos (Beginn des Synchronworts in x).
    Takt fein nachgestellt und Pegel/Gleichanteil per Ausgleichsrechnung aus dem bekannten Synchronwort.
    Rueckgabe (Symbole in {-3,-1,1,3}, Guete 0..1) oder None, wenn ausserhalb des Signals."""
    sps = fs / rate
    best = None
    s = np.asarray(sync, float)
    for d in np.linspace(-0.45, 0.45, 9):
        t = pos + (np.arange(len(sync)) + 0.5 + d) * sps
        if t[0] < 0 or t[-1] >= len(x) - 1:
            return None
        v = np.interp(t, np.arange(len(x)), x)
        a, b = np.polyfit(s, v, 1)                        # v = a*s + b  (a enthaelt Polaritaet und Hub)
        err = np.mean((v - (a * s + b)) ** 2) / (a * a + 1e-30)
        if best is None or err < best[0]:
            best = (err, d, a, b)
    err, d, a, b = best
    t = pos + (np.arange(start, start + count) + 0.5 + d) * sps
    if t[0] < 0 or t[-1] >= len(x) - 1:
        return None
    v = (np.interp(t, np.arange(len(x)), x) - b) / a
    sym = np.clip(np.round((v + 3) / 2) * 2 - 3, -3, 3).astype(int)
    quality = float(max(0.0, 1 - err / 1.0))
    return [int(q) for q in sym], quality


# ---------- Hamming-/Golay-/RS-Bausteine ----------
def _hamming15_11(r: list[int]) -> list[int]:
    """Hamming(15,11,3) (DMR BPTC-Zeilen): 1 Fehler korrigieren. r: 15 Bits, Daten 0..10, Paritaet 11..14."""
    d = r
    p = [d[0] ^ d[1] ^ d[2] ^ d[3] ^ d[5] ^ d[7] ^ d[8], d[1] ^ d[2] ^ d[3] ^ d[4] ^ d[6] ^ d[8] ^ d[9],
         d[2] ^ d[3] ^ d[4] ^ d[5] ^ d[7] ^ d[9] ^ d[10], d[0] ^ d[1] ^ d[2] ^ d[4] ^ d[6] ^ d[7] ^ d[10]]
    syn = tuple(p[i] ^ d[11 + i] for i in range(4))
    if not any(syn):
        return d
    for pos in range(15):                                 # Syndrom des Einzelfehlers suchen
        t = list(d)
        t[pos] ^= 1
        q = [t[0] ^ t[1] ^ t[2] ^ t[3] ^ t[5] ^ t[7] ^ t[8], t[1] ^ t[2] ^ t[3] ^ t[4] ^ t[6] ^ t[8] ^ t[9],
             t[2] ^ t[3] ^ t[4] ^ t[5] ^ t[7] ^ t[9] ^ t[10], t[0] ^ t[1] ^ t[2] ^ t[4] ^ t[6] ^ t[7] ^ t[10]]
        if all(q[i] == t[11 + i] for i in range(4)):
            return t
    return d


def _hamming13_9(c: list[int]) -> list[int]:
    """Hamming(13,9,3) (DMR BPTC-Spalten): 1 Fehler korrigieren."""
    def par(t):
        return [t[0] ^ t[1] ^ t[3] ^ t[5] ^ t[6], t[0] ^ t[1] ^ t[2] ^ t[4] ^ t[6] ^ t[7],
                t[0] ^ t[1] ^ t[2] ^ t[3] ^ t[5] ^ t[7] ^ t[8], t[0] ^ t[2] ^ t[4] ^ t[5] ^ t[8]]
    if all(a == b for a, b in zip(par(c), c[9:13])):
        return c
    for pos in range(13):
        t = list(c)
        t[pos] ^= 1
        if all(a == b for a, b in zip(par(t), t[9:13])):
            return t
    return c


def bptc196(bits: list[int]):
    """BPTC(196,96): Entschachteln, Hamming-Korrektur (Spalten, Zeilen), 96 Datenbits. Rueckgabe (Bits, Zeilen ohne Fehler)."""
    de = [bits[(a * 181) % 196] for a in range(196)]
    for _ in range(2):
        for col in range(15):                             # Spalten: 13 Zeilen, Index 1 + r*15 + col
            c = [de[1 + r * 15 + col] for r in range(13)]
            c = _hamming13_9(c)
            for r in range(13):
                de[1 + r * 15 + col] = c[r]
        for row in range(9):
            r = de[1 + row * 15: 1 + row * 15 + 15]
            de[1 + row * 15: 1 + row * 15 + 15] = _hamming15_11(r)
    ok = 0
    for row in range(9):
        r = de[1 + row * 15: 1 + row * 15 + 15]
        if _hamming15_11(r) == r and r == _hamming15_11(r):
            ok += 1
    out = de[4:12]
    for row in range(1, 9):
        out += de[1 + row * 15: 1 + row * 15 + 11]
    return out, ok


# Golay(20,8) des DMR-Slot-Type: verkuerzter zyklischer Golay-Code (Generator 0xC75) plus Paritaetsbit, systematisch
# (an echten Aufnahmen bestaetigt). Dekodieren: naechstes Codewort, hoechstens 3 Bitfehler.
def _golay2087_enc(d8: int) -> int:
    v = d8 << 11
    for i in range(18, 10, -1):
        if (v >> i) & 1:
            v ^= 0xC75 << (i - 11)
    r = v & 0x7FF
    return (d8 << 12) | (r << 1) | (bin((d8 << 11) | r).count("1") & 1)


_G2087 = [_golay2087_enc(d) for d in range(256)]


def golay2087(word: int):
    """20-Bit-Wort -> (8 Datenbits, Bitfehler) oder (None, Fehler), wenn mehr als 3 Fehler."""
    best = min(range(256), key=lambda d: bin(_G2087[d] ^ word).count("1"))
    err = bin(_G2087[best] ^ word).count("1")
    return (best, err) if err <= 3 else (None, err)


# Reed-Solomon (12,9) ueber GF(256), Primitivpolynom x^8+x^4+x^3+x^2+1, Generator mit den Nullstellen a^1..a^3
_EXP = [0] * 512
_LOG = [0] * 256
_v = 1
for _i in range(255):
    _EXP[_i] = _v
    _LOG[_v] = _i
    _v <<= 1
    if _v & 0x100:
        _v ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _gmul(a, b):
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def rs129_parity(data9: list[int]) -> list[int]:
    gen = [1]
    for i in range(1, 4):                                 # (x - a^1)(x - a^2)(x - a^3)
        ng = [0] * (len(gen) + 1)
        for j, g in enumerate(gen):
            ng[j] ^= g
            ng[j + 1] ^= _gmul(g, _EXP[i])
        gen = ng
    reg = [0, 0, 0]
    for d in data9:
        fb = d ^ reg[0]
        reg = [reg[1] ^ _gmul(fb, gen[1]), reg[2] ^ _gmul(fb, gen[2]), _gmul(fb, gen[3])]
    return reg


def crc_ccitt(data: list[int]) -> int:
    """CRC-CCITT (x^16+x^12+x^5+1, Start 0, invertiert) wie bei DMR-CSBK/Datenkopf."""
    c = 0
    for b in data:
        c ^= b << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
    return c ^ 0xFFFF


CSBK_OP = {0x38: "BS-Abschaltung", 0x3D: "Praeambel", 0x19: "Aloha", 0x1C: "Ahoy", 0x1F: "Kanalzuweisung", 0x28: "Broadcast", 0x04: "Unit-to-Unit-Anfrage", 0x05: "Unit-to-Unit-Antwort", 0x20: "Bestaetigung"}

DT_NAMES = {0: "PI-Kopf", 1: "Sprachkopf", 2: "Abschluss", 3: "CSBK", 4: "MBC-Kopf", 5: "MBC", 6: "Datenkopf",
            7: "Daten 1/2", 8: "Daten 3/4", 9: "Leerlauf", 10: "Daten 1/1", 11: "USB-Daten"}


# ---------- DMR ----------
def dmr_bursts(x: np.ndarray, fs: float) -> list[dict]:
    """Alle DMR-Bursts in x: Art, Zeitschlitz, Colorcode und – bei Sprachkopf/Abschluss – Quelle und Ziel."""
    p = next(q for q in dvsync.PROTOCOLS if q["id"] == "dmr")
    hits = []
    for kind, syms in p["syncs"].items():
        t = dvsync._template(syms, 4800, fs)
        c = dvsync._ncc(np.asarray(x, np.float64), t)
        for pol in (1, -1):
            for i in dvsync._peaks(c * pol, 0.72, int(len(t) * 0.8)):
                hits.append((i, pol, kind, syms))
    hits.sort()
    # Sprach- und Daten-Synchronwort sind bitweise gespiegelt: mit falscher Polaritaet passt das jeweils andere. Die Polaritaet
    # gilt fuer die ganze Aussendung – gewaehlt wird die, bei der die Colorcodes der Datenbursts am einheitlichsten sind.
    if hits:
        score = {}
        for pol0 in (1, -1):
            ccs = []
            for pos, pol, kind, syms in hits:
                if pol != pol0 or "Daten" not in kind:
                    continue
                r = sample_symbols(x, fs, pos, [pol * v for v in syms], -54, 54 + 24 + 54)
                if r:
                    sym = [pol * v for v in r[0]]
                    st = _bits_of(sym[0:54])[98:108] + _bits_of(sym[78:132])[0:10]
                    ccs.append(_num(st[0:4]))
            score[pol0] = (max(ccs.count(c) for c in set(ccs)) if ccs else 0)
        gpol = max(score, key=score.get)
        hits = [h for h in hits if h[1] == gpol]
    out = []
    for pos, pol, kind, syms in hits:
        sy = [pol * s for s in syms]                      # Kehrlage: Symbole des Synchronworts gespiegelt
        r = sample_symbols(x, fs, pos, sy, -66, 66 + 24 + 54)
        if not r:
            continue
        sym, q = r
        sym = [pol * s for s in sym]
        cach = _bits_of(sym[0:12])                        # nur bei Basisstation (BS) belegt
        b1 = _bits_of(sym[12:66])                         # 108 Bit vor dem Synchronwort
        b2 = _bits_of(sym[90:144])                        # 108 Bit danach
        e = dict(t=round(pos / fs, 3), kind=kind, q=round(q, 2))
        if kind.startswith("BS"):
            tact = [cach[i] for i in (0, 4, 8, 12, 14, 18, 22)]
            e["slot"] = tact[1]
        if "Daten" in kind:
            st = b1[98:108] + b2[0:10]
            d8, nerr = golay2087(_num(st))
            if d8 is None:                                # Slot Type nicht lesbar: Burst verwerfen
                continue
            e["cc"], e["dt"], e["st_err"] = d8 >> 4, d8 & 15, nerr
            e["dtn"] = DT_NAMES.get(e["dt"], str(e["dt"]))
            if e["dt"] in (3, 6):
                e["raw196"] = b1[0:98] + b2[10:108]
                data, _ = bptc196(e["raw196"])
                by = [_num(data[i:i + 8]) for i in range(0, 96, 8)]
                mask = 0xA5A5 if e["dt"] == 3 else 0xCCCC
                e["crc"] = crc_ccitt(by[0:10]) == (((by[10] << 8) | by[11]) ^ mask)
                if e["crc"] and e["dt"] == 3:
                    op = by[0] & 0x3F
                    e.update(csbk=op, csbkn=CSBK_OP.get(op, f"0x{op:02X}"), fid=by[1])
                    if op in (0x3D, 0x04, 0x05):          # Praeambel/Unit-to-Unit: Ziel und Quelle
                        e.update(dst=(by[4] << 16) | (by[5] << 8) | by[6], src=(by[7] << 16) | (by[8] << 8) | by[9])
            if e["dt"] in (1, 2):                         # Sprachkopf / Abschluss: LC aus BPTC(196,96)
                e["raw196"] = b1[0:98] + b2[10:108]
                data, ok = bptc196(e["raw196"])
                by = [_num(data[i:i + 8]) for i in range(0, 96, 8)]
                mask = 0x96 if e["dt"] == 1 else 0x99
                par = rs129_parity(by[0:9])
                e["crc"] = [b ^ mask for b in by[9:12]] == par
                e["lcb"] = by
                e["rows_ok"] = ok
                if e["crc"]:
                    flco = by[0] & 0x3F
                    e.update(flco=flco, fid=by[1], dst=(by[3] << 16) | (by[4] << 8) | by[5], src=(by[6] << 16) | (by[7] << 8) | by[8],
                             type="group" if flco == 0 else "private" if flco == 3 else "data" if flco == 0x30 else str(flco))
                    if flco == 0x30:                      # Abschluss nach Datenuebertragung (TD_LC), keine Sprache
                        e["dtn"] = "Datenabschluss"
        out.append(e)
    return out
