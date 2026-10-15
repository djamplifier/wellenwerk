"""LZHUF-Kompression im B2-Format (Winlink/FBB).

Algorithmus nach lzhuf.c von Haruhiko Okumura (LZSS) und Haruyasu Yoshizaki (adaptive Huffman-Codierung),
Lizenz laut Autoren: "Use, distribute, and modify this program freely". Parameter wie im FBB/Winlink-Umfeld
(Fenster 2048, Vorschau 60). B2-Rahmen: CRC16 (XMODEM, little endian) ueber Laenge+Daten, Laenge (4 Byte LE), Daten.
Gegen die Referenzdateien von wl2k-go byte-genau geprueft.
"""
import struct

N, F, THRESHOLD = 2048, 60, 2
NIL = N
N_CHAR = 256 - THRESHOLD + F
T = N_CHAR * 2 - 1
R = T - 1
MAX_FREQ = 0x8000

P_LEN = bytes([3] + [4] * 3 + [5] * 8 + [6] * 12 + [7] * 24 + [8] * 16)
P_CODE = bytes([0x00, 0x20, 0x30, 0x40, 0x50, 0x58, 0x60, 0x68, 0x70, 0x78, 0x80, 0x88, 0x90, 0x94, 0x98, 0x9C,
                0xA0, 0xA4, 0xA8, 0xAC, 0xB0, 0xB4, 0xB8, 0xBC] + list(range(0xC0, 0xF0, 2)) + list(range(0xF0, 0x100)))
D_CODE = bytes([0] * 32 + [1] * 16 + [2] * 16 + [3] * 16 + [4] * 8 + [5] * 8 + [6] * 8 + [7] * 8 + [8] * 8 + [9] * 8
               + [10] * 8 + [11] * 8 + sum(([c] * 4 for c in range(12, 24)), []) + sum(([c] * 2 for c in range(24, 48)), [])
               + list(range(48, 64)))
D_LEN = bytes([3] * 32 + [4] * 48 + [5] * 64 + [6] * 48 + [7] * 48 + [8] * 16)


def _crc_table():
    t = []
    for i in range(256):
        c = i << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) if c & 0x8000 else (c << 1)
        t.append(c & 0xFFFF)
    return t


CRC_TAB = _crc_table()


def crc16(data: bytes) -> int:
    c = 0
    for b in data:
        c = ((c << 8) & 0xFF00) ^ CRC_TAB[c >> 8] ^ b
    for _ in range(2):
        c = ((c << 8) & 0xFF00) ^ CRC_TAB[c >> 8]
    return c


class _Huff:
    def __init__(self):
        self.freq = [0] * (T + 1)
        self.prnt = [0] * (T + N_CHAR)
        self.son = [0] * T
        for i in range(N_CHAR):
            self.freq[i] = 1
            self.son[i] = i + T
            self.prnt[i + T] = i
        i, j = 0, N_CHAR
        while j <= R:
            self.freq[j] = self.freq[i] + self.freq[i + 1]
            self.son[j] = i
            self.prnt[i] = self.prnt[i + 1] = j
            i += 2
            j += 1
        self.freq[T] = 0xFFFF
        self.prnt[R] = 0

    def reconst(self):
        freq, son, prnt = self.freq, self.son, self.prnt
        j = 0
        for i in range(T):
            if son[i] >= T:
                freq[j] = (freq[i] + 1) // 2
                son[j] = son[i]
                j += 1
        i, j = 0, N_CHAR
        while j < T:
            f = freq[i] + freq[i + 1]
            freq[j] = f
            k = j - 1
            while f < freq[k]:
                k -= 1
            k += 1
            freq[k + 1:j + 1] = freq[k:j]
            freq[k] = f
            son[k + 1:j + 1] = son[k:j]
            son[k] = i
            i += 2
            j += 1
        for i in range(T):
            k = son[i]
            prnt[k] = i
            if k < T:
                prnt[k + 1] = i

    def update(self, c):
        freq, son, prnt = self.freq, self.son, self.prnt
        if freq[R] == MAX_FREQ:
            self.reconst()
        c = prnt[c + T]
        while True:
            freq[c] += 1
            k = freq[c]
            if c + 1 <= T and k > freq[c + 1]:
                l = c + 1
                while k > freq[l + 1]:
                    l += 1
                freq[c] = freq[l]
                freq[l] = k
                i = son[c]
                prnt[i] = l
                if i < T:
                    prnt[i + 1] = l
                j = son[l]
                son[l] = i
                prnt[j] = c
                if j < T:
                    prnt[j + 1] = c
                son[c] = j
                c = l
            c = prnt[c]
            if c == 0:
                break


def compress(data: bytes) -> bytes:
    """Daten -> B2-Block (CRC, Laenge, LZHUF)."""
    h = _Huff()
    text = bytearray(N + F - 1)
    lson = [NIL] * (N + 1)
    rson = [NIL] * (N + 257)
    dad = [NIL] * (N + 1)
    out = bytearray()
    st = dict(putbuf=0, putlen=0, mlen=0, mpos=0)

    def putcode(l, c):
        pb = (st["putbuf"] | (c >> st["putlen"])) & 0xFFFF
        st["putlen"] += l
        if st["putlen"] >= 8:
            out.append(pb >> 8)
            st["putlen"] -= 8
            if st["putlen"] >= 8:
                out.append(pb & 0xFF)
                st["putlen"] -= 8
                pb = (c << (l - st["putlen"])) & 0xFFFF
            else:
                pb = (pb << 8) & 0xFFFF
        st["putbuf"] = pb

    def encode_char(c):
        i = j = 0
        k = h.prnt[c + T]
        while True:
            i >>= 1
            if k & 1:
                i += 0x8000
            j += 1
            k = h.prnt[k]
            if k == R:
                break
        putcode(j, i)
        h.update(c)

    def encode_pos(c):
        i = c >> 6
        putcode(P_LEN[i], P_CODE[i] << 8)
        putcode(6, (c & 0x3F) << 10)

    def insert(r):
        cmp = 1
        p = N + 1 + text[r]
        rson[r] = lson[r] = NIL
        mlen = 0
        mpos = st["mpos"]
        while True:
            if cmp >= 0:
                if rson[p] != NIL:
                    p = rson[p]
                else:
                    rson[p] = r
                    dad[r] = p
                    st["mlen"], st["mpos"] = mlen, mpos
                    return
            else:
                if lson[p] != NIL:
                    p = lson[p]
                else:
                    lson[p] = r
                    dad[r] = p
                    st["mlen"], st["mpos"] = mlen, mpos
                    return
            i = 1
            while i < F:
                cmp = text[r + i] - text[p + i]
                if cmp:
                    break
                i += 1
            if i > THRESHOLD:
                if i > mlen:
                    mpos = ((r - p) & (N - 1)) - 1
                    mlen = i
                    if mlen >= F:
                        break
                if i == mlen:
                    c = ((r - p) & (N - 1)) - 1
                    if c < mpos:
                        mpos = c
        st["mlen"], st["mpos"] = mlen, mpos
        dad[r] = dad[p]
        lson[r] = lson[p]
        rson[r] = rson[p]
        dad[lson[p]] = r
        dad[rson[p]] = r
        if rson[dad[p]] == p:
            rson[dad[p]] = r
        else:
            lson[dad[p]] = r
        dad[p] = NIL

    def delete(p):
        if dad[p] == NIL:
            return
        if rson[p] == NIL:
            q = lson[p]
        elif lson[p] == NIL:
            q = rson[p]
        else:
            q = lson[p]
            if rson[q] != NIL:
                while rson[q] != NIL:
                    q = rson[q]
                rson[dad[q]] = lson[q]
                dad[lson[q]] = dad[q]
                lson[q] = lson[p]
                dad[lson[p]] = q
            rson[q] = rson[p]
            dad[rson[p]] = q
        dad[q] = dad[p]
        if rson[dad[p]] == p:
            rson[dad[p]] = q
        else:
            lson[dad[p]] = q
        dad[p] = NIL

    size = len(data)
    if size:
        s, r = 0, N - F
        for i in range(r):
            text[i] = 0x20
        ln = min(F, size)
        text[r:r + ln] = data[:ln]
        pos = ln
        for i in range(1, F + 1):
            insert(r - i)
        insert(r)
        while True:
            if st["mlen"] > ln:
                st["mlen"] = ln
            if st["mlen"] <= THRESHOLD:
                st["mlen"] = 1
                encode_char(text[r])
            else:
                encode_char(255 - THRESHOLD + st["mlen"])
                encode_pos(st["mpos"])
            last = st["mlen"]
            i = 0
            while i < last and pos < size:
                c = data[pos]
                pos += 1
                delete(s)
                text[s] = c
                if s < F - 1:
                    text[s + N] = c
                s = (s + 1) & (N - 1)
                r = (r + 1) & (N - 1)
                insert(r)
                i += 1
            while i < last:
                i += 1
                delete(s)
                s = (s + 1) & (N - 1)
                r = (r + 1) & (N - 1)
                ln -= 1
                if ln:
                    insert(r)
            if ln <= 0:
                break
        if st["putlen"]:
            out.append(st["putbuf"] >> 8)
    body = struct.pack("<I", size) + bytes(out)
    return struct.pack("<H", crc16(body)) + body


class LzhufError(ValueError):
    pass


def decompress(blob: bytes) -> bytes:
    """B2-Block -> Daten (prueft CRC und Laenge)."""
    if len(blob) < 6:
        raise LzhufError("komprimierte Daten zu kurz")
    crc, = struct.unpack_from("<H", blob, 0)
    if crc16(blob[2:]) != crc:
        raise LzhufError("Pruefsumme der komprimierten Daten falsch")
    size, = struct.unpack_from("<I", blob, 2)
    src = blob[6:]
    h = _Huff()
    text = bytearray(b" " * (N - F)) + bytearray(F)
    r = N - F
    out = bytearray()
    bitbuf = bitcnt = 0
    idx = 0
    nsrc = len(src)

    def bits(n):
        nonlocal bitbuf, bitcnt, idx
        while bitcnt < n:
            bitbuf = (bitbuf << 8) | (src[idx] if idx < nsrc else 0)
            idx += 1
            bitcnt += 8
        bitcnt -= n
        v = (bitbuf >> bitcnt) & ((1 << n) - 1)
        bitbuf &= (1 << bitcnt) - 1
        return v

    son = h.son
    while len(out) < size:
        if idx > nsrc + 2:
            raise LzhufError("komprimierte Daten unvollstaendig")
        c = son[R]
        while c < T:
            c = son[c + bits(1)]
        c -= T
        h.update(c)
        if c < 256:
            out.append(c)
            text[r] = c
            r = (r + 1) & (N - 1)
        else:
            i = bits(8)
            hi = D_CODE[i] << 6
            j = D_LEN[i] - 2
            while j > 0:
                i = (i << 1) + bits(1)
                j -= 1
            p = hi | (i & 0x3F)
            i = (r - p - 1) & (N - 1)
            for k in range(c - 255 + THRESHOLD):
                b = text[(i + k) & (N - 1)]
                out.append(b)
                text[r] = b
                r = (r + 1) & (N - 1)
    return bytes(out[:size])
