#!/usr/bin/env python3
import json
import re
import unicodedata
import urllib.request
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
AUTO_PATH = ROOT / "auto-releases.json"
DISNEY_SOURCE = ROOT / "movies.mjs"
MCU_SOURCE = ROOT / "mcu-movies.mjs"
STAR_WARS_SOURCE = ROOT / "star-wars-content.mjs"

SOURCES = [
    {
        "url": "https://en.wikipedia.org/wiki/List_of_Walt_Disney_Animation_Studios_films",
        "bucket": "disneyPixar",
        "studio": "Disney",
    },
    {
        "url": "https://en.wikipedia.org/wiki/List_of_Pixar_films",
        "bucket": "disneyPixar",
        "studio": "Pixar",
    },
    {
        "url": "https://en.wikipedia.org/wiki/List_of_Marvel_Cinematic_Universe_films",
        "bucket": "mcu",
        "studio": None,
    },
]

MONTHS = (
    "January|February|March|April|May|June|July|August|"
    "September|October|November|December"
)
FULL_DATE_RE = re.compile(
    rf"\b({MONTHS})\s+(\d{{1,2}}),\s+(\d{{4}})\b",
    re.IGNORECASE,
)
ISO_DATE_RE = re.compile(r"\b(20\d{2})-(\d{2})-(\d{2})\b")


def normalize_title(value):
    value = unicodedata.normalize("NFKD", str(value))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.replace("&", " and ")
    value = re.sub(r"[^a-zA-Z0-9]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip().lower()

    # Treat sequel numbers written as Roman numerals and Arabic numerals as
    # equivalent (e.g. "Frozen II" vs "Frozen 2").
    roman = {
        "i": "1",
        "ii": "2",
        "iii": "3",
        "iv": "4",
        "v": "5",
        "vi": "6",
        "vii": "7",
        "viii": "8",
        "ix": "9",
        "x": "10",
    }
    tokens = [roman.get(token, token) for token in value.split()]
    return " ".join(tokens)


def clean_title(value):
    text = str(value).replace("\xa0", " ").strip()
    text = re.sub(r"\[[^\]]+\]", "", text)
    text = text.replace("†", "").replace("‡", "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def exact_release_date(value):
    text = re.sub(r"\[[^\]]+\]", "", str(value))
    m = FULL_DATE_RE.search(text)
    if m:
        return datetime.strptime(m.group(0), "%B %d, %Y").date()
    m = ISO_DATE_RE.search(text)
    if m:
        return datetime.strptime(m.group(0), "%Y-%m-%d").date()
    return None


def flatten_columns(df):
    if isinstance(df.columns, pd.MultiIndex):
        cols = []
        for col in df.columns:
            parts = []
            for part in col:
                s = str(part).strip()
                if s and s.lower() != "nan" and s not in parts:
                    parts.append(s)
            cols.append(" ".join(parts))
        df.columns = cols
    else:
        df.columns = [str(c).strip() for c in df.columns]
    return df


def find_col(columns, predicate):
    for col in columns:
        if predicate(str(col).strip().lower()):
            return col
    return None


def fetch_html(url):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "BrentStremioCatalogReleaseSync/1.0 "
                          "(GitHub Actions; catalog maintenance)"
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def discover(source):
    html = fetch_html(source["url"])
    tables = pd.read_html(StringIO(html))
    found = []

    for raw in tables:
        df = flatten_columns(raw.copy())
        columns = list(df.columns)

        film_col = find_col(
            columns,
            lambda c: c == "film" or c == "title" or c.startswith("film "),
        )
        date_col = find_col(columns, lambda c: "release date" in c)
        director_col = find_col(columns, lambda c: "director" in c)

        if source.get("type") == "series":
            if not film_col:
                film_col = find_col(
                    columns,
                    lambda c: c == "series" or c.startswith("series "),
                )
            if not date_col:
                date_col = find_col(
                    columns,
                    lambda c: (
                        "originally released" in c
                        or "first aired" in c
                        or "first released" in c
                        or "premiere" in c
                        or "original release" in c
                    ),
                )
            if not (film_col and date_col):
                continue
        else:
            # Filmography/upcoming tables have all three. This avoids
            # reception, box-office, and cancelled-project tables.
            if not (film_col and date_col and director_col):
                continue

        for _, row in df.iterrows():
            title = clean_title(row.get(film_col, ""))
            if not title or title.lower() in {"nan", "film", "title", "tba"}:
                continue

            excluded = source.get("exclude_titles", set())
            if normalize_title(title) in excluded:
                continue

            release_date = exact_release_date(row.get(date_col, ""))
            if release_date is None:
                # Never guess partial/TBA dates. It will be reconsidered once
                # the source provides a full release date.
                continue

            found.append(
                {
                    "title": title,
                    "year": release_date.year,
                    "releaseDate": release_date.isoformat(),
                    **({"studio": source["studio"]} if source["studio"] else {}),
                    **({"type": source["type"]} if source.get("type") else {}),
                }
            )

    # Same title can appear in more than one table/section.
    deduped = {}
    for item in found:
        key = normalize_title(item["title"])
        prior = deduped.get(key)
        if prior is None or item["releaseDate"] < prior["releaseDate"]:
            deduped[key] = item
    return list(deduped.values())


def names_from_js(path):
    # These source modules contain only catalog data. Reading every quoted
    # string intentionally captures aliases as well as canonical titles, which
    # prevents alternate display names from being mistaken for new releases.
    text = path.read_text(encoding="utf-8")
    return re.findall(r'"([^"]+)"', text)


def main():
    today = datetime.now(timezone.utc).date()
    auto = json.loads(AUTO_PATH.read_text(encoding="utf-8"))
    auto.setdefault("disneyPixar", [])
    auto.setdefault("mcu", [])
    auto.setdefault("starWarsMovies", [])
    auto.setdefault("starWarsSeries", [])

    existing = {
        "disneyPixar": {
            normalize_title(t)
            for t in names_from_js(DISNEY_SOURCE)
        },
        "mcu": {
            normalize_title(t)
            for t in names_from_js(MCU_SOURCE)
        },
        "starWarsMovies": {
            normalize_title(t)
            for t in names_from_js(STAR_WARS_SOURCE)
        },
        "starWarsSeries": {
            normalize_title(t)
            for t in names_from_js(STAR_WARS_SOURCE)
        },
    }
    for bucket in ("disneyPixar", "mcu"):
        existing[bucket].update(
            normalize_title(item["title"]) for item in auto[bucket]
        )

    additions = {
        "disneyPixar": [],
        "mcu": [],
    }

    for source in SOURCES:
        bucket = source["bucket"]
        for item in discover(source):
            release_date = datetime.strptime(
                item["releaseDate"], "%Y-%m-%d"
            ).date()

            # Only add movies after the listed release date has arrived.
            if release_date > today:
                continue

            key = normalize_title(item["title"])
            # Source tables often shorten titles ("Rebels", "Episode IV – A
            # New Hope", "Visions Presents"). Treat a clear containment match
            # as already-known so aliases do not get auto-added as duplicates.
            known = existing[bucket]
            if key in known or any(
                len(key) >= 5 and (key in candidate or candidate in key)
                for candidate in known
            ):
                continue

            additions[bucket].append(item)
            existing[bucket].add(key)

    changed = False
    for bucket in ("disneyPixar", "mcu"):
        if additions[bucket]:
            additions[bucket].sort(
                key=lambda x: (x["releaseDate"], x["title"])
            )
            auto[bucket].extend(additions[bucket])
            auto[bucket].sort(
                key=lambda x: (x["releaseDate"], x["title"])
            )
            changed = True
            for item in additions[bucket]:
                print(
                    f'NEW {bucket}: {item["title"]} '
                    f'({item["releaseDate"]})'
                )

    if changed:
        AUTO_PATH.write_text(
            json.dumps(auto, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    else:
        print("No newly released Disney/Pixar/MCU films found. Star Wars canon list is curated separately.")


if __name__ == "__main__":
    main()
