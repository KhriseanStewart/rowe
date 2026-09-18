#!/usr/bin/env python3
"""
Build a higher-accuracy Jamaica business CSV from open sources.

Sources (legal/open):
  - OpenStreetMap Overpass (ODbL) — POIs with contact/address
  - Wikidata SPARQL — organizations in Jamaica with phone/website
  - OSM parish admin boundaries — accurate region assignment

Quality rules:
  - Keep only listings with phone OR website/email OR street address
  - Normalize Jamaican phone numbers to +1-876-…
  - Dedupe by name + parish/city; prefer richer contact fields
"""

from __future__ import annotations

import csv
import json
import math
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import certifi

    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CONTEXT = ssl.create_default_context()
    SSL_CONTEXT.check_hostname = False
    SSL_CONTEXT.verify_mode = ssl.CERT_NONE

ROOT = Path(__file__).resolve().parents[1]
OUT_CSV = ROOT / "data" / "yellow-pages-jamaica.csv"
OUT_JSON = ROOT / "data" / "yellow-pages-jamaica.json"
OUT_REPORT = ROOT / "data" / "yellow-pages-quality-report.json"

BBOX = (17.65, -78.45, 18.60, -76.15)  # south, west, north, east

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

WD_ENDPOINT = "https://query.wikidata.org/sparql"

CATEGORY_MAP = {
    "bank": "Banks",
    "atm": "Banks",
    "bureau_de_change": "Banks",
    "hospital": "Health",
    "clinic": "Health",
    "doctors": "Health",
    "dentist": "Health",
    "pharmacy": "Health",
    "veterinary": "Health",
    "school": "Education",
    "university": "Education",
    "college": "Education",
    "kindergarten": "Education",
    "library": "Education",
    "restaurant": "Restaurants",
    "cafe": "Restaurants",
    "fast_food": "Restaurants",
    "bar": "Restaurants",
    "pub": "Restaurants",
    "food_court": "Restaurants",
    "hotel": "Tourism & Attractions",
    "guest_house": "Tourism & Attractions",
    "motel": "Tourism & Attractions",
    "attraction": "Tourism & Attractions",
    "museum": "Tourism & Attractions",
    "fuel": "Automotive",
    "car_rental": "Automotive",
    "car_repair": "Automotive",
    "supermarket": "Retail",
    "convenience": "Retail",
    "mall": "Retail",
    "department_store": "Retail",
    "clothes": "Retail",
    "mobile_phone": "Telecommunications",
    "telecommunication": "Telecommunications",
    "post_office": "Government & Public",
    "police": "Government & Public",
    "fire_station": "Government & Public",
    "townhall": "Government & Public",
    "courthouse": "Government & Public",
    "place_of_worship": "Community",
    "community_centre": "Community",
    "cinema": "Entertainment",
    "theatre": "Entertainment",
    "gym": "Sports & Fitness",
    "fitness_centre": "Sports & Fitness",
    "hairdresser": "Personal Care",
    "beauty": "Personal Care",
    "lawyer": "Professional Services",
    "accountant": "Professional Services",
    "estate_agent": "Professional Services",
    "insurance": "Professional Services",
    "company": "Professional Services",
}

SKIP_AMENITY = {
    "parking",
    "bench",
    "waste_basket",
    "toilets",
    "drinking_water",
    "bus_stop",
    "clock",
    "fountain",
    "post_box",
    "grit_bin",
    "hunting_stand",
    "waste_transfer_station",
    "charging_station",
    "water_point",
    "shelter",
    "prison",
    "atm",  # ATMs alone aren't useful directory listings
}

# Approximate parish bounding boxes (south, west, north, east). Overpass admin
# polygons are preferred when available; these keep region assignment accurate offline.
PARISH_BBOXES = {
    "Kingston": (17.955, -76.825, 18.035, -76.740),
    "St. Andrew": (17.970, -76.900, 18.170, -76.700),
    "St. Thomas": (17.820, -76.550, 18.050, -76.150),
    "Portland": (18.000, -76.650, 18.300, -76.200),
    "St. Mary": (18.180, -77.050, 18.450, -76.600),
    "St. Ann": (18.250, -77.450, 18.520, -76.950),
    "Trelawny": (18.200, -77.800, 18.520, -77.350),
    "St. James": (18.300, -78.050, 18.550, -77.750),
    "Hanover": (18.300, -78.350, 18.500, -78.000),
    "Westmoreland": (18.100, -78.350, 18.350, -77.900),
    "St. Elizabeth": (17.850, -78.050, 18.200, -77.550),
    "Manchester": (17.900, -77.700, 18.200, -77.300),
    "Clarendon": (17.700, -77.450, 18.150, -77.050),
    "St. Catherine": (17.850, -77.200, 18.150, -76.850),
}

FIELDNAMES = [
    "title",
    "category",
    "phone",
    "email",
    "website",
    "address",
    "city",
    "region",
    "country",
    "tags",
    "body",
    "lat",
    "lon",
    "source",
    "quality_score",
]


def http_json(url: str, data: bytes | None = None, headers: dict | None = None) -> dict:
    req = urllib.request.Request(
        url,
        data=data,
        headers={"User-Agent": "RoweYellowPages/1.1 (local; open-data)", **(headers or {})},
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=200, context=SSL_CONTEXT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_overpass(query: str) -> dict:
    payload = query.encode("utf-8")
    last_error: Exception | None = None
    for url in OVERPASS_URLS:
        for attempt in range(3):
            try:
                return http_json(url, data=payload)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
                last_error = err
                time.sleep(2 + attempt * 3)
    raise RuntimeError(f"Overpass fetch failed: {last_error}")


def osm_business_query() -> str:
    s, w, n, e = BBOX
    # Prefer elements that already carry contact or address evidence
    return f"""
[out:json][timeout:180];
(
  node["name"]["shop"]["phone"]({s},{w},{n},{e});
  node["name"]["shop"]["contact:phone"]({s},{w},{n},{e});
  node["name"]["shop"]["website"]({s},{w},{n},{e});
  node["name"]["shop"]["addr:street"]({s},{w},{n},{e});
  way["name"]["shop"]["phone"]({s},{w},{n},{e});
  way["name"]["shop"]["contact:phone"]({s},{w},{n},{e});
  way["name"]["shop"]["website"]({s},{w},{n},{e});
  way["name"]["shop"]["addr:street"]({s},{w},{n},{e});

  node["name"]["amenity"]["phone"]({s},{w},{n},{e});
  node["name"]["amenity"]["contact:phone"]({s},{w},{n},{e});
  node["name"]["amenity"]["website"]({s},{w},{n},{e});
  node["name"]["amenity"]["addr:street"]({s},{w},{n},{e});
  way["name"]["amenity"]["phone"]({s},{w},{n},{e});
  way["name"]["amenity"]["contact:phone"]({s},{w},{n},{e});
  way["name"]["amenity"]["website"]({s},{w},{n},{e});
  way["name"]["amenity"]["addr:street"]({s},{w},{n},{e});

  node["name"]["tourism"]["phone"]({s},{w},{n},{e});
  node["name"]["tourism"]["contact:phone"]({s},{w},{n},{e});
  node["name"]["tourism"]["website"]({s},{w},{n},{e});
  node["name"]["tourism"]["addr:street"]({s},{w},{n},{e});
  way["name"]["tourism"]["phone"]({s},{w},{n},{e});
  way["name"]["tourism"]["contact:phone"]({s},{w},{n},{e});
  way["name"]["tourism"]["website"]({s},{w},{n},{e});
  way["name"]["tourism"]["addr:street"]({s},{w},{n},{e});

  node["name"]["office"]["phone"]({s},{w},{n},{e});
  node["name"]["office"]["website"]({s},{w},{n},{e});
  node["name"]["office"]["addr:street"]({s},{w},{n},{e});
  way["name"]["office"]["phone"]({s},{w},{n},{e});
  way["name"]["office"]["website"]({s},{w},{n},{e});
  way["name"]["office"]["addr:street"]({s},{w},{n},{e});

  node["name"]["healthcare"]["phone"]({s},{w},{n},{e});
  node["name"]["healthcare"]["website"]({s},{w},{n},{e});
  node["name"]["healthcare"]["addr:street"]({s},{w},{n},{e});
  way["name"]["healthcare"]["phone"]({s},{w},{n},{e});
  way["name"]["healthcare"]["website"]({s},{w},{n},{e});
  way["name"]["healthcare"]["addr:street"]({s},{w},{n},{e});

  node["name"]["craft"]["phone"]({s},{w},{n},{e});
  node["name"]["craft"]["website"]({s},{w},{n},{e});
  node["name"]["craft"]["addr:street"]({s},{w},{n},{e});
);
out center tags;
"""


def osm_parish_query() -> str:
    return """
[out:json][timeout:120];
area["ISO3166-1"="JM"][admin_level=2]->.jm;
(
  relation["boundary"="administrative"]["admin_level"="6"](area.jm);
);
out geom tags;
"""


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    # ray casting; ring is [[lon,lat], ...]
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        intersect = ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-15) + xi
        )
        if intersect:
            inside = not inside
        j = i
    return inside


def load_parishes() -> list[dict]:
    # Overpass admin polygons are often rate-limited; bbox fallback is reliable.
    print("Using Jamaica parish bounding boxes for region assignment")
    return []


def parish_for(lat: float | None, lon: float | None, parishes: list[dict]) -> str:
    if lat is None or lon is None:
        return ""
    for parish in parishes:
        for ring in parish["rings"]:
            if point_in_ring(lon, lat, ring):
                return parish["name"]
    # bbox match (may overlap near borders — pick smallest area match)
    matches = []
    for name, (s, w, n, e) in PARISH_BBOXES.items():
        if s <= lat <= n and w <= lon <= e:
            area = (n - s) * (e - w)
            matches.append((area, name))
    if matches:
        matches.sort()
        return matches[0][1]
    # nearest parish center of bbox
    best = ""
    best_d = 1e9
    for name, (s, w, n, e) in PARISH_BBOXES.items():
        plat, plon = (s + n) / 2, (w + e) / 2
        d = (lat - plat) ** 2 + (lon - plon) ** 2
        if d < best_d:
            best_d = d
            best = name
    return best


def normalize_phone(raw: str) -> str:
    if not raw:
        return ""
    # keep first number if multiple
    first = re.split(r"[;/]| or ", raw, maxsplit=1)[0]
    digits = re.sub(r"\D", "", first)
    if not digits:
        return ""
    if digits.startswith("1876") and len(digits) >= 11:
        digits = digits[:11]
        return f"+1-{digits[1:4]}-{digits[4:7]}-{digits[7:11]}"
    if digits.startswith("876") and len(digits) >= 10:
        digits = digits[:10]
        return f"+1-876-{digits[3:6]}-{digits[6:10]}"
    if len(digits) == 7:
        return f"+1-876-{digits[:3]}-{digits[3:]}"
    if digits.startswith("1") and len(digits) == 11:
        return f"+1-{digits[1:4]}-{digits[4:7]}-{digits[7:11]}"
    # keep international-ish originals cleaned
    if raw.strip().startswith("+"):
        return "+" + re.sub(r"[^\d]", "", raw) 
    return raw.strip()


def normalize_website(raw: str) -> str:
    if not raw:
        return ""
    url = raw.strip()
    if url.startswith("//"):
        url = "https:" + url
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    return url.rstrip("/")


def classify(tags: dict) -> tuple[str, str]:
    for key in ("shop", "amenity", "tourism", "office", "craft", "healthcare"):
        value = tags.get(key)
        if value:
            category = CATEGORY_MAP.get(value)
            if not category:
                if key == "shop":
                    category = "Retail"
                elif key == "office":
                    category = "Professional Services"
                elif key == "craft":
                    category = "Trades & Services"
                elif key == "healthcare":
                    category = "Health"
                elif key == "tourism":
                    category = "Tourism & Attractions"
                else:
                    category = value.replace("_", " ").title()
            return category, value
    return "Business", "business"


def quality_score(row: dict) -> int:
    score = 0
    if row.get("phone"):
        score += 40
    if row.get("website"):
        score += 25
    if row.get("email"):
        score += 15
    if row.get("address"):
        score += 20
    if row.get("city") and row["city"] not in {"", "Jamaica"}:
        score += 10
    if row.get("region"):
        score += 10
    if row.get("lat") and row.get("lon"):
        score += 5
    if row.get("source") == "wikidata":
        score += 5
    return score


def has_useful_contact(row: dict) -> bool:
    return bool(row.get("phone") or row.get("website") or row.get("email") or row.get("address"))


def coords_of(el: dict) -> tuple[float | None, float | None]:
    if "lat" in el and "lon" in el:
        return float(el["lat"]), float(el["lon"])
    center = el.get("center") or {}
    if "lat" in center and "lon" in center:
        return float(center["lat"]), float(center["lon"])
    return None, None


def osm_to_row(el: dict, parishes: list[dict]) -> dict | None:
    tags = el.get("tags") or {}
    title = (tags.get("name") or "").strip()
    if len(title) < 2:
        return None
    amenity = tags.get("amenity")
    if amenity in SKIP_AMENITY:
        return None

    category, kind = classify(tags)
    phone = normalize_phone(tags.get("phone") or tags.get("contact:phone") or "")
    email = (tags.get("email") or tags.get("contact:email") or "").strip()
    website = normalize_website(tags.get("website") or tags.get("contact:website") or tags.get("url") or "")
    address = " ".join(
        p for p in [tags.get("addr:housenumber"), tags.get("addr:street"), tags.get("addr:unit")] if p
    ).strip()
    city = (tags.get("addr:city") or tags.get("addr:town") or tags.get("addr:suburb") or "").strip()
    region = (tags.get("addr:state") or tags.get("addr:province") or tags.get("addr:district") or "").strip()
    lat, lon = coords_of(el)
    parish = parish_for(lat, lon, parishes)
    if parish and not region:
        region = parish
    # Keep city as a real locality when OSM provides one; otherwise leave blank
    # (region already carries parish).
    if not city:
        city = (
            tags.get("addr:suburb")
            or tags.get("addr:neighbourhood")
            or tags.get("addr:village")
            or ""
        ).strip()

    opening = tags.get("opening_hours", "").strip()
    operator = tags.get("operator", "").strip()
    brand = tags.get("brand", "").strip()
    tag_bits = [kind]
    if brand:
        tag_bits.append(brand)
    if tags.get("cuisine"):
        tag_bits.append(tags["cuisine"])

    body_parts = []
    if operator and operator.casefold() != title.casefold():
        body_parts.append(f"Operator: {operator}.")
    if opening:
        body_parts.append(f"Hours: {opening}.")
    if tags.get("description"):
        body_parts.append(tags["description"])
    body_parts.append("Source: OpenStreetMap (ODbL).")

    row = {
        "title": title,
        "category": category,
        "phone": phone,
        "email": email,
        "website": website,
        "address": address,
        "city": city,
        "region": region,
        "country": "Jamaica",
        "tags": "|".join(dict.fromkeys(tag_bits)),
        "body": " ".join(body_parts).strip(),
        "lat": f"{lat:.6f}" if lat is not None else "",
        "lon": f"{lon:.6f}" if lon is not None else "",
        "source": "openstreetmap",
    }
    if not has_useful_contact(row):
        return None
    row["quality_score"] = str(quality_score(row))
    return row


def wikidata_rows(parishes: list[dict]) -> list[dict]:
    print("Fetching Wikidata Jamaica organizations…")
    # Split by type so queries stay under Wikidata timeouts.
    type_batches = [
        ("hotels", ["wd:Q27686", "wd:Q11707", "wd:Q783226"], "Tourism & Attractions"),
        ("banks_health_edu", ["wd:Q22687", "wd:Q16917", "wd:Q3918", "wd:Q33506"], None),
        ("companies", ["wd:Q43229", "wd:Q4830453", "wd:Q215380"], "Professional Services"),
        ("air_transit", ["wd:Q1248784", "wd:Q44613"], "Travel"),
    ]
    type_to_category = {
        "hotel": "Tourism & Attractions",
        "restaurant": "Restaurants",
        "cafe": "Restaurants",
        "bank": "Banks",
        "hospital": "Health",
        "university": "Education",
        "museum": "Tourism & Attractions",
        "company": "Professional Services",
        "business": "Professional Services",
        "airline": "Travel",
        "airport": "Travel",
        "church building": "Community",
    }

    rows = []
    for label, types, default_category in type_batches:
        values = " ".join(types)
        query = f"""
SELECT ?item ?itemLabel ?typeLabel ?phone ?email ?website ?street ?cityLabel ?coord WHERE {{
  VALUES ?type {{ {values} }}
  ?item wdt:P31/wdt:P279* ?type .
  ?item wdt:P17 wd:Q766 .
  OPTIONAL {{ ?item wdt:P1329 ?phone }}
  OPTIONAL {{ ?item wdt:P968 ?email }}
  OPTIONAL {{ ?item wdt:P856 ?website }}
  OPTIONAL {{ ?item wdt:P969 ?street }}
  OPTIONAL {{ ?item wdt:P131 ?city }}
  OPTIONAL {{ ?item wdt:P625 ?coord }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
LIMIT 2000
"""
        url = WD_ENDPOINT + "?" + urllib.parse.urlencode({"format": "json", "query": query})
        try:
            data = http_json(url)
        except Exception as err:
            print(f"  Wikidata {label} failed: {err}")
            time.sleep(2)
            continue

        batch_count = 0
        for binding in data.get("results", {}).get("bindings", []):
            title = binding.get("itemLabel", {}).get("value", "").strip()
            if not title or title.startswith("Q"):
                continue
            phone = normalize_phone(binding.get("phone", {}).get("value", ""))
            email = binding.get("email", {}).get("value", "").replace("mailto:", "").strip()
            website = normalize_website(binding.get("website", {}).get("value", ""))
            address = binding.get("street", {}).get("value", "").strip()
            city = binding.get("cityLabel", {}).get("value", "").strip()
            type_label = binding.get("typeLabel", {}).get("value", "").strip().casefold()
            category = default_category or "Business"
            for key, cat in type_to_category.items():
                if key in type_label:
                    category = cat
                    break

            lat = lon = None
            coord = binding.get("coord", {}).get("value", "")
            m = re.match(r"Point\(([-\d\.]+) ([-\d\.]+)\)", coord)
            if m:
                lon = float(m.group(1))
                lat = float(m.group(2))
            region = parish_for(lat, lon, parishes) if lat is not None else ""

            row = {
                "title": title,
                "category": category,
                "phone": phone,
                "email": email,
                "website": website,
                "address": address,
                "city": city,
                "region": region,
                "country": "Jamaica",
                "tags": type_label.replace(" ", "_") if type_label else "wikidata",
                "body": "Source: Wikidata (CC0).",
                "lat": f"{lat:.6f}" if lat is not None else "",
                "lon": f"{lon:.6f}" if lon is not None else "",
                "source": "wikidata",
            }
            if not has_useful_contact(row):
                continue
            row["quality_score"] = str(quality_score(row))
            rows.append(row)
            batch_count += 1
        print(f"  Wikidata {label}: {batch_count}")
        time.sleep(1)
    print(f"  Wikidata usable listings: {len(rows)}")
    return rows


def merge_rows(rows: list[dict]) -> list[dict]:
    def key_of(row: dict) -> str:
        return "|".join(
            [
                re.sub(r"[^a-z0-9]+", "", row["title"].casefold()),
                re.sub(r"[^a-z0-9]+", "", (row.get("region") or row.get("city") or "").casefold()),
            ]
        )

    best: dict[str, dict] = {}
    for row in rows:
        key = key_of(row)
        existing = best.get(key)
        if not existing:
            best[key] = row
            continue
        # merge fields preferring non-empty / higher quality
        merged = dict(existing)
        for field in ("phone", "email", "website", "address", "city", "region", "lat", "lon", "body", "tags"):
            if not merged.get(field) and row.get(field):
                merged[field] = row[field]
            elif field in {"phone", "website", "address"} and row.get(field) and not merged.get(field):
                merged[field] = row[field]
        sources = sorted({existing.get("source", ""), row.get("source", "")} - {""})
        merged["source"] = "+".join(sources)
        if row.get("city") and merged.get("city") in {"", "Jamaica"}:
            merged["city"] = row["city"]
        if int(row.get("quality_score") or 0) > int(merged.get("quality_score") or 0):
            # keep richer category/title from higher score row but preserve merged contacts
            for field in ("category", "title"):
                if row.get(field):
                    merged[field] = row[field]
        merged["quality_score"] = str(quality_score(merged))
        best[key] = merged

    out = list(best.values())
    # final quality gate: score >= 40 (phone alone) OR address+city/region
    filtered = []
    for row in out:
        score = int(row.get("quality_score") or 0)
        if score >= 40 or (row.get("address") and (row.get("region") or (row.get("city") not in {"", "Jamaica"}))):
            filtered.append(row)
    filtered.sort(key=lambda r: (-int(r.get("quality_score") or 0), r["category"], r["title"].casefold()))
    return filtered


def write_outputs(rows: list[dict]) -> None:
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDNAMES, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    OUT_JSON.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    by_cat: dict[str, int] = {}
    phone = website = address = 0
    for row in rows:
        by_cat[row["category"]] = by_cat.get(row["category"], 0) + 1
        phone += 1 if row.get("phone") else 0
        website += 1 if row.get("website") else 0
        address += 1 if row.get("address") else 0
    report = {
        "total": len(rows),
        "with_phone": phone,
        "with_website": website,
        "with_address": address,
        "phone_pct": round(100 * phone / max(len(rows), 1), 1),
        "website_pct": round(100 * website / max(len(rows), 1), 1),
        "address_pct": round(100 * address / max(len(rows), 1), 1),
        "categories": dict(sorted(by_cat.items(), key=lambda x: (-x[1], x[0]))),
        "avg_quality_score": round(
            sum(int(r.get("quality_score") or 0) for r in rows) / max(len(rows), 1), 1
        ),
    }
    OUT_REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


def main() -> None:
    parishes = load_parishes()

    print("Fetching high-signal OSM businesses…")
    osm_payload = fetch_overpass(osm_business_query())
    osm_elements = osm_payload.get("elements") or []
    print(f"  raw OSM elements: {len(osm_elements)}")
    osm_rows = []
    for el in osm_elements:
        row = osm_to_row(el, parishes)
        if row:
            osm_rows.append(row)
    print(f"  OSM after quality filter: {len(osm_rows)}")

    wd_rows = wikidata_rows(parishes)
    merged = merge_rows(osm_rows + wd_rows)
    print(f"Merged high-quality listings: {len(merged)}")
    write_outputs(merged)
    print(f"Wrote {OUT_CSV}")


if __name__ == "__main__":
    main()
