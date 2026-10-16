"""Erkennung digitaler Sprechfunkverfahren am FM-Diskriminator-Signal – alle Verfahren gleichzeitig.

Jedes Verfahren hat feste Synchronwoerter (Rahmenanfaenge), die in festem Takt wiederkehren. Gesucht wird per
normierter Kreuzkorrelation (unabhaengig von Pegel, Hub und Frequenzablage) mit beiden Polaritaeten; ein Treffer
zaehlt erst, wenn ein zweiter im passenden Rahmenabstand folgt. Eingang: Diskriminator-Ausgang (Frequenzabweichung)
mit beliebiger Rate ab 12 kHz – vom eigenen IQ-Empfang (48 kHz) oder vom FM-Ton eines OpenWebRX (12 kHz).

Synchronwoerter (Dibit 01 -> +3, 00 -> +1, 10 -> -1, 11 -> -3):
  DMR    ETSI TS 102 361-1, Tab. 9.2 (BS/MS, Sprache/Daten, 48 bit)
  P25    TIA-102.BAAA, Frame Sync 0x5575F5FF77FF
  YSF    Frame Sync Word 0xD471C9634D
  NXDN   Frame Sync Word 0xCDF59
  M17    Sync LSF 0x55F7, Stream 0xFF5D, Paket 0x75FF
  D-STAR Daten-Sync 1010101010 1101000 1101000 (GMSK, 1 bit je Symbol), alle 21 Sprachrahmen
"""
from __future__ import annotations

import numpy as np


def _hex_syms(h: str, nbits: int) -> list[int]:
    v, out = int(h, 16), []
    m = {0b01: 3, 0b00: 1, 0b10: -1, 0b11: -3}
    for i in range(nbits // 2 - 1, -1, -1):
        out.append(m[(v >> (2 * i)) & 3])
    return out


def _bits(s: str) -> list[int]:
    return [1 if c == "1" else -1 for c in s]


# Kennung, Symbolrate, Synchronwoerter {Art: Symbole}, Rahmenabstand (Symbole), Mindestkorrelation,
# chain: so viele Treffer muessen exakt im Rahmentakt aufeinander folgen (kurze Synchronwoerter kommen in Nutzdaten zufaellig vor),
# cover: Anteil der Rahmen im belegten Abschnitt, die ein Synchronwort tragen muessen
PROTOCOLS = [
    dict(id="dmr", label="DMR", rate=4800, period=144, thr=0.80, chain=2, cover=0, syncs={
        "BS Sprache": _hex_syms("755FD7DF75F7", 48), "BS Daten": _hex_syms("DFF57D75DF5D", 48),
        "MS Sprache": _hex_syms("7F7D5DD57DFD", 48), "MS Daten": _hex_syms("D5D7F77FD757", 48)}),
    dict(id="p25", label="P25", rate=4800, period=864, thr=0.80, chain=2, cover=0, syncs={"": _hex_syms("5575F5FF77FF", 48)}),
    dict(id="ysf", label="YSF (C4FM)", rate=4800, period=480, thr=0.80, chain=2, cover=0.3, syncs={"": _hex_syms("D471C9634D", 40)}),
    dict(id="nxdn", label="NXDN96", rate=4800, period=384, thr=0.78, chain=3, cover=0.5, syncs={"": _hex_syms("CDF59", 20)}),
    dict(id="nxdn48", label="NXDN48", rate=2400, period=192, thr=0.86, chain=3, cover=0.5, syncs={"": _hex_syms("CDF59", 20)}),
    dict(id="m17", label="M17", rate=4800, period=192, thr=0.88, chain=6, cover=0.6, syncs={
        "LSF": _hex_syms("55F7", 16), "Stream": _hex_syms("FF5D", 16), "Paket": _hex_syms("75FF", 16)}),
    dict(id="dstar", label="D-STAR", rate=4800, period=2016, thr=0.72, low=0.08, chain=2, cover=0, syncs={"": _bits("101010101011010001101000")}),
]


def _template(syms: list[int], rate: float, fs: float) -> np.ndarray:
    """Symbolfolge als Signalform bei Abtastrate fs (Rechteck, leicht geglaettet wie nach dem Empfangsfilter)."""
    sps = fs / rate
    n = int(round(len(syms) * sps))
    t = np.minimum((np.arange(n) / sps).astype(int), len(syms) - 1)
    x = np.asarray(syms, np.float64)[t]
    k = max(1, int(round(sps / 2)))
    if k > 1:
        x = np.convolve(x, np.ones(k) / k, mode="same")
    x -= x.mean()
    return x / (np.linalg.norm(x) or 1)


def _ncc(x: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Normierte Kreuzkorrelation (Pearson) von t ueber x, Laenge len(x) - len(t) + 1."""
    L = len(t)
    if len(x) < L:
        return np.zeros(0)
    n = 1 << int(np.ceil(np.log2(len(x) + L)))
    num = np.fft.irfft(np.fft.rfft(x, n) * np.conj(np.fft.rfft(t, n)), n)[: len(x) - L + 1]
    c1, c2 = np.concatenate([[0], np.cumsum(x)]), np.concatenate([[0], np.cumsum(x * x)])
    s1, s2 = c1[L:] - c1[:-L], c2[L:] - c2[:-L]
    var = np.maximum(s2 - s1 * s1 / L, 1e-12)
    return num / np.sqrt(var)


def _peaks(c: np.ndarray, thr: float, gap: int) -> list[int]:
    idx = np.flatnonzero(c > thr)
    out: list[int] = []
    for i in idx:
        if out and i - out[-1] < gap:
            if c[i] > c[out[-1]]:
                out[-1] = int(i)
        else:
            out.append(int(i))
    return out


def diag(x: np.ndarray, fs: float) -> dict:
    """Hoechste Korrelation je Verfahren (auch unbestaetigt) – zur Fehlersuche."""
    x = np.asarray(x, np.float64)
    out = {}
    for p in PROTOCOLS:
        if fs / p["rate"] < 2.2 or len(x) < fs * 0.2:
            continue
        out[p["id"]] = round(max(float(np.max(np.abs(_ncc(x, _template(s, p["rate"], fs))))) for s in p["syncs"].values()), 2)
    return out


def _inner(x: np.ndarray, fs: float, starts: list[int], rate: float, L: int = 8) -> float:
    """Anteil der Symbole auf den inneren Pegeln (4FSK: um 0,5; binaer: deutlich weniger), gemessen nach jedem Synchronwort."""
    sps, xm = fs / rate, x - np.median(x)
    ref, vals = [], []
    for i0 in starts:
        for k in range(L + 150):
            j = int(round(i0 + (k + 0.5) * sps))
            if j >= len(xm):
                break
            (ref if k < L else vals).append(abs(xm[j]) if k < L else xm[j])
    if not vals or not ref:
        return 1.0
    v = np.asarray(vals)
    return float(np.mean(np.abs(v - np.median(v)) / (np.mean(ref) or 1) < 0.6))


def _chain(found: list, per: float, tol: float) -> list[int]:
    """Laengste Kette von Treffern gleicher Polaritaet im Abstand eines Vielfachen von per (Indizes in found)."""
    best: list[int] = []
    for pol in (1, -1):
        idx = [i for i, h in enumerate(found) if h[1] == pol]
        nxt: dict[int, list[int]] = {}
        for ai, a in enumerate(idx):
            for b in idx[ai + 1:]:
                d = found[b][0] - found[a][0]
                if d > per * 12.5:
                    break
                k = round(d / per)
                if k >= 1 and abs(d - k * per) <= tol * (1 + 0.1 * k):
                    nxt.setdefault(a, []).append(b)
        memo: dict[int, list[int]] = {}
        for a in reversed(idx):
            tail = max((memo[b] for b in nxt.get(a, [])), key=len, default=[])
            memo[a] = [a] + tail
            if len(memo[a]) > len(best):
                best = memo[a]
    return best


def detect(x: np.ndarray, fs: float) -> list[dict]:
    """Diskriminator-Signal x (Rate fs) untersuchen. Ergebnis: erkannte Verfahren, bestes zuerst:
    {id, label, hits (bestaetigte Synchronwoerter), score 0..1, polarity (+1/-1), kinds {Name: Anzahl}, times (s)}"""
    x = np.asarray(x, np.float64)
    if len(x) < fs * 0.2:
        return []
    res = []
    for p in PROTOCOLS:
        sps = fs / p["rate"]
        if sps < 2.2:                                   # zu grob abgetastet fuer dieses Verfahren
            continue
        per, tol = p["period"] * sps, max(2.5, sps * 1.2)
        found = []                                      # (Position, Polaritaet, Art, Korrelation)
        for kind, syms in p["syncs"].items():
            t = _template(syms, p["rate"], fs)
            c = _ncc(x, t)
            for pol in (1, -1):
                for i in _peaks(c * pol, p["thr"] - p.get("low", 0), int(len(t) * 0.8)):   # D-STAR: etwas unter der Schwelle, Kette reisst bei Schwund nicht
                    found.append((i, pol, kind, float(c[i] * pol)))
        found.sort()
        best = _chain(found, per, max(1.5, sps * 0.6))
        # Gegenprobe: dieselbe Suche mit falschen Rahmentakten. Zufallstreffer (Rauschen, fremde Daten) bilden dort
        # aehnlich lange Ketten – echte Synchronwoerter nur im richtigen Takt
        decoy = max(len(_chain(found, per * q, max(1.5, sps * 0.6))) for q in (0.83, 1.21, 1.37))
        if len(best) < max(p["chain"], 2 * decoy) or max(found[i][3] for i in best) < p["thr"]:
            continue                                     # mindestens ein Treffer muss die volle Schwelle erreichen
        hits = [found[i] for i in best]
        span = (hits[-1][0] - hits[0][0]) / per + 1      # moegliche Rahmen im belegten Abschnitt
        cover = len(hits) / span
        if cover < p["cover"]:
            continue
        if p["id"] == "m17" and _inner(x, fs, [h[0] for h in hits], p["rate"]) < 0.38:
            continue                                     # nur zwei Pegel zwischen den Synchronwoertern: binaer (D-STAR-Fuellmuster), kein M17
        pol = hits[0][1]
        kinds: dict[str, int] = {}
        for h in hits:
            if h[2]:
                kinds[h[2]] = kinds.get(h[2], 0) + 1
        corr = float(np.mean([h[3] for h in hits]))
        score = min(1.0, 0.4 + 0.12 * min(len(hits), 4) + 0.3 * (corr - p["thr"]) / (1 - p["thr"]) + 0.1 * min(1, cover))
        res.append(dict(id=p["id"], label=p["label"], hits=len(hits), score=round(score, 2), polarity=pol, kinds=kinds,
                        times=[round(h[0] / fs, 3) for h in hits][:40], corr=round(corr, 2), cover=round(cover, 2)))
    # D-STAR-Fuellmuster (Zusatzdaten im Ruhezustand) wiederholt sich alle 2 Sprachrahmen = M17-Rahmentakt: M17 nur bei klarer Mehrheit
    ids = {r["id"]: r for r in res}
    if "m17" in ids and "dstar" in ids and ids["m17"]["hits"] < 15:
        res.remove(ids["m17"])
    res.sort(key=lambda r: (-r["score"], -r["hits"]))
    return res
