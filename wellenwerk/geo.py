"""Maidenhead-Locator, Entfernung und Richtung."""
import math
import re

_GRID = re.compile(r"^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$", re.I)


def valid_grid(g: str | None) -> bool:
    return bool(g) and bool(_GRID.match(g.strip()))


def grid_to_latlon(g: str) -> tuple[float, float] | None:
    """Mittelpunkt des Locator-Feldes (4, 6 oder 8 Stellen)."""
    if not valid_grid(g):
        return None
    g = g.strip().upper()
    lon = (ord(g[0]) - 65) * 20 - 180
    lat = (ord(g[1]) - 65) * 10 - 90
    lon += int(g[2]) * 2
    lat += int(g[3])
    w, h = 2.0, 1.0
    if len(g) >= 6:
        lon += (ord(g[4]) - 65) * (2 / 24)
        lat += (ord(g[5]) - 65) * (1 / 24)
        w, h = 2 / 24, 1 / 24
    if len(g) >= 8:
        lon += int(g[6]) * (2 / 240)
        lat += int(g[7]) * (1 / 240)
        w, h = 2 / 240, 1 / 240
    return lat + h / 2, lon + w / 2


def latlon_to_grid(lat: float, lon: float, chars: int = 6) -> str:
    lon += 180
    lat += 90
    g = chr(65 + int(lon // 20)) + chr(65 + int(lat // 10))
    lon %= 20
    lat %= 10
    g += str(int(lon // 2)) + str(int(lat // 1))
    if chars >= 6:
        lon %= 2
        lat %= 1
        g += chr(97 + int(lon / (2 / 24))) + chr(97 + int(lat / (1 / 24)))
    return g[:2] + g[2:4] + g[4:].lower()


def distance_bearing(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    """Grosskreis-Entfernung in km und Anfangsrichtung in Grad von a nach b."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d = 2 * math.asin(math.sqrt(math.sin((lat2 - lat1) / 2) ** 2
                                + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2))
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    brg = (math.degrees(math.atan2(y, x)) + 360) % 360
    return round(d * 6371.0), round(brg)
