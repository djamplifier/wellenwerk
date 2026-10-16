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


# ---------- D-STAR (JARL) ----------
# Funkkopf: Praeambel + Rahmensync 111011001010000, 660 Bit = verwuerfelt (x^7+x^4+1), verschachtelt (24er-Raster),
# Faltungscode r=1/2 K=3 (111/101); 41 Byte LSB zuerst, CRC-CCITT (reflektiert, Start FFFF, invertiert).
# Sprachrahmen: 72 Bit AMBE + 24 Bit langsame Daten (mit 70 4F 93 verwuerfelt); jeder 21. Rahmen traegt den Daten-Sync.
# Langsame Daten in Rahmenpaaren (6 Byte): 0x4n Textnachricht Block n (5 Zeichen), 0x5L Kopfdaten (L Byte), 0x3L GPS/DPRS.
DS_HDR = [1 if c == "1" else -1 for c in "1010101010101010" + "111011001010000"]
DS_SYNC = [1 if c == "1" else -1 for c in "101010101011010001101000"]


def _ds_scramble(b):
    s, out = [1] * 7, []
    for v in b:
        fb = s[3] ^ s[6]
        out.append(v ^ fb)
        s = [fb] + s[:6]
    return out


def _ds_deint(b):
    out, k = [0] * 660, 0
    for i in range(660):
        out[k] = b[i]
        k += 24
        if k >= 672:
            k -= 671
        elif k >= 660:
            k -= 647
    return out


def _viterbi_k3(b):
    INF = 1 << 30
    metric, paths = [0, INF, INF, INF], [[], [], [], []]
    for i in range(len(b) // 2):
        r0, r1 = b[2 * i], b[2 * i + 1]
        nm, npth = [INF] * 4, [None] * 4
        for st in range(4):
            if metric[st] >= INF:
                continue
            s1, s2 = st & 1, (st >> 1) & 1
            for u in (0, 1):
                ns, m = ((st << 1) | u) & 3, metric[st] + ((u ^ s1 ^ s2) != r0) + ((u ^ s2) != r1)
                if m < nm[ns]:
                    nm[ns], npth[ns] = m, paths[st] + [u]
        metric, paths = nm, npth
    best = min(range(4), key=lambda s: metric[s])
    return paths[best], metric[best]


def _crc_ds(by) -> int:
    c = 0xFFFF
    for b in by:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ 0x8408 if c & 1 else c >> 1
    return c ^ 0xFFFF


def _ds_header(by) -> dict | None:
    if len(by) < 41 or _crc_ds(by[:39]) != (by[39] | (by[40] << 8)):
        return None
    s = lambda a, b: bytes(by[a:b]).decode("latin-1").strip()
    my, my2 = s(27, 35), s(35, 39)
    return dict(protocol="DSTAR", flags=by[0], destination=s(3, 11), departure=s(11, 19), yourcall=s(19, 27), ourcall=my + (f"/{my2}" if my2 else ""))


def _sample_bits(x, fs, pos, sync, start, count, pol):
    r = sample_symbols(x, fs, pos, [3 * pol * v for v in sync], start, count)
    return None if not r else [1 if pol * s > 0 else 0 for s in r[0]]


def _pol_hits(x, fs, sync, thr):
    t = dvsync._template(sync, 4800, fs)
    c = dvsync._ncc(np.asarray(x, np.float64), t)
    return [(i, pol) for pol in (1, -1) for i in dvsync._peaks(c * pol, thr, len(t))]


def dstar(x: np.ndarray, fs: float) -> list[dict]:
    """D-STAR-Meldungen in x: Funkkoepfe (CRC geprueft) und je Superrahmen Textnachricht bzw. wiederholter Kopf."""
    out = []
    for pos, pol in _pol_hits(x, fs, DS_HDR, 0.7):
        b = _sample_bits(x, fs, pos, DS_HDR, len(DS_HDR), 660, pol)
        if b:
            dec, _m = _viterbi_k3(_ds_deint(_ds_scramble(b)))
            h = _ds_header([sum(dec[i * 8 + k] << k for k in range(8)) for i in range(41)])
            if h:
                out.append(dict(t=round(pos / fs, 3), kind="header", **h))
    # langsame Daten: ab jedem Daten-Sync 20 weitere Rahmen (Datenteil je 24 Bit, 72 Bit Sprache dazwischen)
    text, hdr, texts = {}, [], []
    scr = [0x70, 0x4F, 0x93]
    for pos, pol in sorted(_pol_hits(x, fs, DS_SYNC, 0.72)):
        b = _sample_bits(x, fs, pos, DS_SYNC, 0, 21 * 96, pol)
        if not b:
            continue
        frames = []
        for k in range(1, 21):
            d = b[k * 96: k * 96 + 24]
            frames.append([sum(d[i * 8 + j] << j for j in range(8)) ^ scr[i] for i in range(3)])
        for k in range(0, 20, 2):
            blk = frames[k] + frames[k + 1]
            typ, n = blk[0] >> 4, blk[0] & 15
            if typ == 4 and n < 4:
                text[n] = bytes(blk[1:6]).decode("latin-1")
            elif typ == 5:
                hdr.extend(blk[1:1 + min(5, n)])
        if len(text) == 4:
            texts.append(("".join(text[i] for i in range(4)), pos))
            text = {}
        for i in range(max(0, len(hdr) - 41) + 1):          # wiederholter Funkkopf (spaeter Einstieg)
            h = _ds_header(hdr[i:i + 41]) if len(hdr) >= i + 41 else None
            if h:
                out.append(dict(t=round(pos / fs, 3), kind="header-sd", **h))
                hdr = []
                break
        if len(hdr) > 120:
            hdr = hdr[-60:]
    for t, p in texts:                                        # rohe Textempfaenge – abgestimmt wird ueber die ganze Aussendung (laufender Dekoder)
        out.append(dict(t=round(p / fs, 3), kind="text-raw", protocol="DSTAR", raw=t))
    return out


def ds_text_vote(cands: list[str]) -> str:
    """Mehrheitsentscheid je Zeichen (Textnachricht ohne Fehlerschutz); nur zurueck, wenn ueberwiegend lesbar."""
    if not cands:
        return ""
    out = []
    for i in range(20):
        cs = [c[i] for c in cands if len(c) > i]
        best = max(set(cs), key=cs.count) if cs else " "
        out.append(best)
    msg = "".join(out).strip()
    ok = sum(1 for ch in msg if 32 <= ord(ch) < 127)
    if not msg or ok / len(msg) < 0.85:
        return ""
    return "".join(ch if 32 <= ord(ch) < 127 else "?" for ch in msg)


# ---------- YSF (Yaesu System Fusion, C4FM) ----------
# Rahmen 100 ms = 480 Symbole: Sync (20), FICH (100), Nutzteil (360 = 90 Byte in 5 Bloecken zu 18 Byte).
# Kopf- und Abschlussrahmen: Datenkanal (je Block die ersten bzw. zweiten 9 Byte) = 180 Dibits verschachtelt (9x20),
# Faltungscode K=5 (g1 = d^d3^d4, g2 = d^d1^d2^d4), 176 Bit = 22 Byte mit CRC-CCITT; die 20 Byte Rufzeichen sind
# mit einer festen Folge „aufgeweisst“. CSD1 = Ziel (10) + Quelle (10), CSD2 = Downlink/Uplink.
YSF_WHITEN = [0x93, 0xD7, 0x51, 0x21, 0x9C, 0x2F, 0x6C, 0xD0, 0xEF, 0x0F, 0xF8, 0x3D, 0xF1, 0x73, 0x20, 0x94, 0xED, 0x1E, 0x7C, 0xD8]


def _viterbi_k5(pairs):
    """pairs: [(s0, s1), ...] -> Bits. Zustand = (d1, d2, d3, d4)."""
    INF = 1 << 30
    metric = [0] + [INF] * 15
    paths = [[] for _ in range(16)]
    for s0, s1 in pairs:
        nm, npth = [INF] * 16, [None] * 16
        for st in range(16):
            if metric[st] >= INF:
                continue
            d1, d2, d3, d4 = st & 1, (st >> 1) & 1, (st >> 2) & 1, (st >> 3) & 1
            for d in (0, 1):
                g1, g2 = d ^ d3 ^ d4, d ^ d1 ^ d2 ^ d4
                ns = (d | (d1 << 1) | (d2 << 2) | (d3 << 3))
                m = metric[st] + (g1 != s0) + (g2 != s1)
                if m < nm[ns]:
                    nm[ns], npth[ns] = m, paths[st] + [d]
        metric, paths = nm, npth
    best = min(range(16), key=lambda s: metric[s])
    return paths[best], metric[best]


def _crc_ccitt162(by) -> bool:
    """CRC-CCITT wie bei YSF/MMDVM: Start 0, Ergebnis invertiert, die letzten zwei Byte enthalten die Pruefsumme."""
    c = 0
    for b in by[:-2]:
        c ^= b << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
    c ^= 0xFFFF
    return by[-2] == (c >> 8) and by[-1] == (c & 0xFF)


def _golay24_tab():
    tab = {}
    for d in range(4096):
        r = d << 11
        for k in range(22, 10, -1):
            if r >> k & 1:
                r ^= 0xC75 << (k - 11)
        c = (d << 11) | r
        tab[d] = (c << 1) | (bin(c).count("1") & 1)
    return tab


_G24 = None


def _golay24_dec(w: int) -> int:
    """Golay(24,12): naechstes Codewort (bis 3 Fehler sicher korrigiert) -> 12 Datenbits."""
    global _G24
    if _G24 is None:
        _G24 = _golay24_tab()
        _G24 = (np.array([_G24[d] for d in range(4096)], np.int64),)
    c = _G24[0]
    x = c ^ w
    dist = np.zeros(4096, np.int64)
    for k in range(24):
        dist += (x >> k) & 1
    return int(np.argmin(dist))


def _ysf_fich(bits: list[int]) -> dict | None:
    """FICH (200 Bit nach dem Sync): verschachtelt 5x20, Faltungscode K=5, 4x Golay(24,12), CRC-CCITT."""
    pairs = []
    for i in range(100):
        n = (i % 5) * 40 + (i // 5) * 2
        pairs.append((bits[n], bits[n + 1]))
    dec, _m = _viterbi_k5(pairs)
    by = []
    for g in range(4):
        by += [_golay24_dec(_num(dec[g * 24:(g + 1) * 24]))]
    raw = []
    for i in range(0, 4, 2):                              # 2 x 12 Bit -> 3 Byte
        v = (by[i] << 12) | by[i + 1]
        raw += [v >> 16, (v >> 8) & 0xFF, v & 0xFF]
    if not _crc_ccitt162(raw):
        return None
    return dict(fi=raw[0] >> 6, fn=(raw[1] >> 3) & 7, ft=raw[1] & 7, dt=raw[2] & 3, dgid=raw[3] & 0x7F)


def _ysf_dch(pay: list[int], width: int, nbits: int, off: int = 0) -> bytes | None:
    """Datenkanal: je Block (18 Byte) width Byte ab off, verschachtelt (width*... x 20), K=5, CRC, Weissung entfernen."""
    dch = []
    for blk in range(5):
        dch += pay[blk * 18 + off: blk * 18 + off + width]
    db = [(dch[i >> 3] >> (7 - (i & 7))) & 1 for i in range(len(dch) * 8)]
    rows = len(db) // 40
    pairs = []
    for i in range(len(db) // 2):
        n = (i % rows) * 40 + (i // rows) * 2
        pairs.append((db[n], db[n + 1]))
    dec, _m = _viterbi_k5(pairs)
    by = [_num(dec[i:i + 8]) for i in range(0, nbits, 8)]
    if not _crc_ccitt162(by):
        return None
    return bytes(b ^ w for b, w in zip(by[:-2], YSF_WHITEN))


def ysf(x: np.ndarray, fs: float) -> list[dict]:
    p = next(q for q in dvsync.PROTOCOLS if q["id"] == "ysf")
    sync = list(p["syncs"].values())[0]
    t = dvsync._template(sync, 4800, fs)
    c = dvsync._ncc(np.asarray(x, np.float64), t)
    out = []
    for pol in (1, -1):
        for pos in dvsync._peaks(c * pol, 0.75, int(len(t) * 0.8)):
            r = sample_symbols(x, fs, pos, [pol * v for v in sync], 0, 480)
            if not r:
                continue
            bits = _bits_of([pol * v for v in r[0]])                # 960 Bit
            fich = _ysf_fich(bits[40:240])
            if not fich:
                continue
            frame = [_num(bits[i:i + 8]) for i in range(0, 960, 8)]   # 120 Byte
            pay = frame[30:120]
            e = dict(t=round(pos / fs, 3), protocol="YSF", fi=fich["fi"], fn=fich["fn"], dt=fich["dt"], dgid=fich["dgid"])
            if fich["fi"] in (0, 2):                              # Kopf/Abschluss: CSD1 und CSD2 vollstaendig
                c1, c2 = _ysf_dch(pay, 9, 176), _ysf_dch(pay, 9, 176, 9)
                if c1:
                    e.update(target=c1[:10].decode("latin-1").strip(), source=c1[10:].decode("latin-1").strip())
                if c2:
                    e.update(down=c2[:10].decode("latin-1").strip(), up=c2[10:].decode("latin-1").strip())
            elif fich["fi"] == 1 and fich["dt"] == 2:              # V/D-Modus 2: je Rahmen ein 10-Zeichen-Feld nach FN
                d = _ysf_dch(pay, 5, 96)
                if d is not None:
                    fld = {0: "target", 1: "source", 2: "down", 3: "up"}.get(fich["fn"])
                    if fld:
                        e[fld] = d[:10].decode("latin-1").strip()
            out.append(e)
    out.sort(key=lambda e: e["t"])
    return out


# ---------- M17 (Spezifikation m17project.org, 4FSK 4800 Bd) ----------
# Rahmen 40 ms = 8 Sync-Symbole + 184 Nutzsymbole (368 Bit). LSF: 240 Bit (Ziel 6, Quelle 6, Typ 2, Meta 14, CRC 2) +4 Nullbits,
# Faltungscode K=5 (wie YSF), Punktierung P1 -> 368 Bit. Stream: LICH (1/6 des LSF + Zaehler, 4x Golay(24,12) = 96 Bit) + 272 Bit
# Nutzteil (Rahmennummer + 16 Byte Codec2, P2). Beide: quadratische Verschachtelung (45i + 92i^2) mod 368, dann Verwuerfelung.
M17_RAND = bytes.fromhex("D6B5E23082FF8462BA4E9690D898DD5D0CC85243911DF86E682F35DA14EACD76198DD580D133871357182D2978C3")
M17_P1 = [1, 1] + [0, 1, 1, 1] * 14 + [0, 1, 1]
M17_P2 = [1] * 11 + [0]
M17_INTRL = [(45 * i + 92 * i * i) % 368 for i in range(368)]
M17_GOLAY = [0x8EB, 0x93E, 0xA97, 0xDC6, 0x367, 0x6CD, 0xD99, 0x3DA, 0x7B4, 0xF68, 0x63B, 0xC75]
M17_CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/."
M17_SYNC = {"lsf": 0x55F7, "str": 0xFF5D, "pkt": 0x75FF, "eot": 0x555D}


def m17_crc(by) -> int:
    c = 0xFFFF
    for b in by:
        c ^= b << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x5935) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
    return c


def m17_golay_enc(d: int) -> int:
    ck = 0
    for i in range(12):
        if d >> i & 1:
            ck ^= M17_GOLAY[i]
    return (d << 12) | ck


_M17G = None


def m17_golay_dec(w: int) -> int | None:
    """Naechstes Codewort; None bei mehr als 3 Fehlern."""
    global _M17G
    if _M17G is None:
        _M17G = np.array([m17_golay_enc(d) for d in range(4096)], np.int64)
    x = _M17G ^ w
    dist = np.zeros(4096, np.int64)
    for k in range(24):
        dist += (x >> k) & 1
    d = int(np.argmin(dist))
    return d if dist[d] <= 3 else None


def m17_call_dec(by) -> str:
    v = int.from_bytes(bytes(by), "big")
    if v == 0xFFFFFFFFFFFF:
        return "@ALL"
    pre = ""
    if v >= 40 ** 9:
        if v >= 40 ** 9 + 40 ** 8:
            return ""
        v -= 40 ** 9
        pre = "#"
    s = ""
    while v:
        s += M17_CHARS[v % 40]
        v //= 40
    return pre + s


def m17_call_enc(c: str) -> bytes:
    c = c.upper()
    if c == "@ALL":
        return b"\xff" * 6
    base, c = (40 ** 9, c[1:]) if c.startswith("#") else (0, c)
    v = 0
    for ch in reversed(c[:9]):
        v = v * 40 + max(0, M17_CHARS.find(ch))
    return (v + base).to_bytes(6, "big")


def _conv5(bits, punct):
    out, sr, p = [], 0, 0
    for b in list(bits) + [0, 0, 0, 0]:
        g = (b ^ (sr >> 2 & 1) ^ (sr >> 3 & 1), b ^ (sr & 1) ^ (sr >> 1 & 1) ^ (sr >> 3 & 1))
        sr = ((sr << 1) | b) & 0xF
        for k in g:
            if punct[p]:
                out.append(k)
            p = (p + 1) % len(punct)
    return out


def _depunct(bits, punct, n_pairs):
    """Punktierte Bits -> Paare mit None an den ausgelassenen Stellen."""
    full, it, p = [], iter(bits), 0
    for _ in range(n_pairs * 2):
        full.append(next(it, None) if punct[p] else None)
        p = (p + 1) % len(punct)
    return list(zip(full[0::2], full[1::2]))


def _viterbi5e(pairs):
    """Viterbi K=5 mit Ausloeschungen (None kostet nichts); Rueckgabe Bits ohne die 4 Nullbits am Ende."""
    INF = 1 << 30
    metric = [0] + [INF] * 15
    hist = []
    for s0, s1 in pairs:
        nm, back = [INF] * 16, [0] * 16
        for st in range(16):
            m0 = metric[st]
            if m0 >= INF:
                continue
            for d in (0, 1):
                g1 = d ^ (st >> 2 & 1) ^ (st >> 3 & 1)
                g2 = d ^ (st & 1) ^ (st >> 1 & 1) ^ (st >> 3 & 1)
                m = m0 + (s0 is not None and g1 != s0) + (s1 is not None and g2 != s1)
                ns = ((st << 1) | d) & 0xF
                if m < nm[ns]:
                    nm[ns], back[ns] = m, st
        metric = nm
        hist.append(back)
    st, bits = 0 if metric[0] < INF else int(np.argmin(metric)), []
    for back in reversed(hist):
        bits.append(st & 1)
        st = back[st]
    bits.reverse()
    return bits[:-4], metric[0]


def _m17_scramble(bits):
    return [b ^ (M17_RAND[i >> 3] >> (7 - (i & 7)) & 1) for i, b in enumerate(bits)]


def _bits8(by):
    return [(b >> (7 - i)) & 1 for b in by for i in range(8)]


def _bytes8(bits):
    return [_num(bits[i:i + 8]) for i in range(0, len(bits) - 7, 8)]


def m17_lsf_bytes(dst: str, src: str, typ: int = 0x0005, meta: bytes = b"") -> bytes:
    d = m17_call_enc(dst) + m17_call_enc(src) + typ.to_bytes(2, "big") + (meta + bytes(14))[:14]
    c = m17_crc(d)
    return d + bytes([c >> 8, c & 0xFF])


def m17_frame_bits(kind: str, lsf: bytes, fn: int = 0, payload: bytes = bytes(16)) -> list[int]:
    """Ein Rahmen als 384 Bit (Sync + verschachtelter, verwuerfelter Inhalt) – fuer Tests und spaeter zum Senden."""
    if kind == "lsf":
        t3 = _conv5(_bits8(lsf), M17_P1)
    else:
        cnt = fn % 6
        ch = list(lsf[cnt * 5:cnt * 5 + 5]) + [cnt << 5]
        lich = []
        for a, b in ((ch[0] << 4 | ch[1] >> 4, (ch[1] & 15) << 8 | ch[2]), (ch[3] << 4 | ch[4] >> 4, (ch[4] & 15) << 8 | ch[5])):
            lich += [(m17_golay_enc(a) >> (23 - i)) & 1 for i in range(24)] + [(m17_golay_enc(b) >> (23 - i)) & 1 for i in range(24)]
        t3 = lich + _conv5(_bits8(bytes([fn >> 8 & 0xFF, fn & 0xFF]) + payload), M17_P2)
    t4 = _m17_scramble([t3[M17_INTRL[i]] for i in range(368)])
    sw = M17_SYNC[kind]
    return [(sw >> (15 - i)) & 1 for i in range(16)] + t4


def m17_bits_to_syms(bits):
    m = {(0, 1): 3, (0, 0): 1, (1, 0): -1, (1, 1): -3}
    return [m[(bits[i], bits[i + 1])] for i in range(0, len(bits), 2)]


def _m17_payload(bits368):
    t3 = [0] * 368
    d = _m17_scramble(bits368)
    for i in range(368):
        t3[M17_INTRL[i]] = d[i]
    return t3


def _m17_lsf_parse(by) -> dict | None:
    if len(by) != 30 or m17_crc(by) != 0:
        return None
    typ = by[12] << 8 | by[13]
    r = dict(destination=m17_call_dec(by[0:6]), source=m17_call_dec(by[6:12]), type=typ,
             stream=bool(typ & 1), voice=(typ >> 1 & 3) in (2, 3), can=typ >> 7 & 15, encrypted=bool(typ >> 3 & 3))
    if (typ >> 5 & 3) == 0 and not r["encrypted"]:                  # Meta = Text (14 Zeichen, falls druckbar)
        t = bytes(by[14:28]).rstrip(b"\x00").decode("latin-1", "replace")
        if t and all(32 <= ord(ch) < 127 for ch in t):
            r["meta_text"] = t
    return r


def m17(x: np.ndarray, fs: float) -> list[dict]:
    """M17-Rahmen in x: LSF (vollstaendig) und Stream-Rahmen (LICH-Teil + Zaehler, Rahmennummer)."""
    p = next(q for q in dvsync.PROTOCOLS if q["id"] == "m17")
    xs = np.asarray(x, np.float64)
    out = []
    for kind, key in (("LSF", "lsf"), ("Stream", "str")):
        sync = p["syncs"][kind]
        t = dvsync._template(sync, 4800, fs)
        c = dvsync._ncc(xs, t)
        for pol in (1, -1):
            for pos in dvsync._peaks(c * pol, 0.8, int(len(t) * 0.8)):
                r = sample_symbols(xs, fs, pos, [pol * v for v in sync], 8, 184)
                if not r:
                    continue
                t3 = _m17_payload(_bits_of([pol * v for v in r[0]]))
                e = dict(t=round(pos / fs, 3), kind=key)
                if key == "lsf":
                    dec, _m = _viterbi5e(_depunct(t3, M17_P1, 244))
                    lsf = _m17_lsf_parse(_bytes8(dec))
                    if not lsf:
                        continue
                    e.update(lsf)
                else:
                    words = [m17_golay_dec(_num(t3[i:i + 24])) for i in range(0, 96, 24)]
                    if None in words:
                        continue
                    ch = []
                    for a, b in ((words[0], words[1]), (words[2], words[3])):
                        v = a << 12 | b
                        ch += [v >> 16, v >> 8 & 0xFF, v & 0xFF]
                    if ch[5] & 0x1F or (ch[5] >> 5) > 5:
                        continue
                    dec, m = _viterbi5e(_depunct(t3[96:], M17_P2, 148))
                    if m > 14:                                    # zufaelliger Sync-Treffer im Nutzteil: Faltungscode passt nicht
                        continue
                    fn = _num(dec[0:16])
                    e.update(lich=ch[:5], cnt=ch[5] >> 5, fn=fn & 0x7FFF, last=bool(fn & 0x8000), err=m)
                out.append(e)
    out.sort(key=lambda e: e["t"])
    return out


def m17_lich_collect(chunks: dict) -> dict | None:
    """6 LICH-Teile (Zaehler 0..5 -> 5 Byte) zum LSF zusammensetzen und pruefen."""
    if len(chunks) < 6:
        return None
    by = []
    for i in range(6):
        by += list(chunks[i])
    return _m17_lsf_parse(by)
