import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mcuMovies } from "./mcu-movies.mjs";

const autoReleases = JSON.parse(await readFile(new URL("./auto-releases.json", import.meta.url), "utf8"));
const allMcuMovies = [...mcuMovies, ...(autoReleases.mcu ?? [])];
const autoCount = (autoReleases.mcu ?? []).length;

const OUT = new URL("./dist/mcu/", import.meta.url);
const CATALOG_ID = "mcu-films";
const CONCURRENCY = 6;
const SORT_OPTIONS = ["Release Date", "IMDb Rating", "Alphabetical"];

function normalize(s = "") {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[·.:'’!?,()*-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getYear(meta) {
  const raw = String(meta.releaseInfo ?? meta.year ?? "");
  const match = raw.match(/\b(18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function score(meta, wantedTitle, wantedYear, aliases = []) {
  const a = normalize(meta.name);
  const names = [wantedTitle, ...aliases].map(normalize);
  const y = getYear(meta);
  let n = 0;

  if (names.some(b => a === b)) n += 120;
  else if (names.some(b => a.includes(b) || b.includes(a))) n += 45;

  if (y === wantedYear) n += 70;
  else if (y && Math.abs(y - wantedYear) === 1) n += 20;

  if (meta.type === "movie") n += 5;
  if (String(meta.id ?? "").startsWith("tt")) n += 10;
  return n;
}

async function fetchJson(url, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "MCUStremioCatalog/1.0" }
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastError;
}

async function searchCinemeta(query) {
  const encoded = encodeURIComponent(query);
  const data = await fetchJson(
    `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encoded}.json`
  );
  return Array.isArray(data.metas) ? data.metas : [];
}

async function getCinemetaMeta(id) {
  try {
    const data = await fetchJson(
      `https://v3-cinemeta.strem.io/meta/movie/${id}.json`,
      3
    );
    return data?.meta ?? {};
  } catch (err) {
    console.warn(`Could not fetch full metadata for ${id}: ${err.message}`);
    return {};
  }
}

function numericRating(value) {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}

function releaseTimestamp(meta, fallbackYear) {
  const raw = meta.released ?? meta.releaseDate ?? null;
  const ts = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ts) ? ts : Date.UTC(fallbackYear, 0, 1);
}

async function resolveMovie(movie) {
  const queries = [movie.title, ...(movie.aliases ?? [])];
  let candidates = [];

  for (const query of queries) {
    const metas = await searchCinemeta(query);
    candidates.push(...metas);

    const best = metas
      .map(meta => ({
        meta,
        score: score(meta, movie.title, movie.year, movie.aliases ?? [])
      }))
      .sort((a, b) => b.score - a.score)[0];

    if (best?.score >= 150) {
      candidates = metas;
      break;
    }
  }

  const ranked = candidates
    .map(meta => ({
      meta,
      score: score(meta, movie.title, movie.year, movie.aliases ?? [])
    }))
    .filter(x => String(x.meta.id ?? "").startsWith("tt"))
    .sort((a, b) => b.score - a.score);

  const winner = ranked[0];
  const winnerName = normalize(winner?.meta?.name ?? "");
  const compatibleNames = [movie.title, ...(movie.aliases ?? [])].map(normalize);
  const titleCompatible = compatibleNames.some(
    wanted =>
      winnerName === wanted ||
      winnerName.includes(wanted) ||
      wanted.includes(winnerName)
  );

  if (!winner || winner.score < 100) {
    if (!titleCompatible || winner.score < 60) {
      throw new Error(
        `Could not confidently resolve ${movie.title} (${movie.year}). Best score: ${winner?.score ?? "none"}`
      );
    }
    console.warn(
      `Accepted title-only match for ${movie.title} (${movie.year}): "${winner.meta.name}" [${winner.meta.id}], score ${winner.score}`
    );
  }

  const id = winner.meta.id;
  let details = winner.meta;

  if (!winner.meta.imdbRating || !winner.meta.released) {
    details = { ...winner.meta, ...(await getCinemetaMeta(id)) };
  }

  const rating = numericRating(details.imdbRating);

  return {
    id,
    type: "movie",
    name: movie.title,
    releaseInfo: String(movie.year),
    poster:
      details.poster ||
      winner.meta.poster ||
      `https://images.metahub.space/poster/medium/${id}/img`,
    ...(rating !== null ? { imdbRating: rating.toFixed(1) } : {}),
    _rating: rating,
    _releaseTs: releaseTimestamp(details, movie.year),
    _resolvedName: winner.meta.name,
    _score: winner.score
  };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      process.stdout.write(
        `Resolved MCU ${i + 1}/${items.length}: ${items[i].title}\n`
      );
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

function publicMeta(item) {
  const { _rating, _releaseTs, _resolvedName, _score, ...meta } = item;
  return meta;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(new URL(`./catalog/movie/${CATALOG_ID}/`, OUT), {
  recursive: true
});

if (allMcuMovies.length < 38) {
  throw new Error(
    `Expected at least 38 released MCU feature films, found ${allMcuMovies.length}.`
  );
}

const resolved = await mapPool(allMcuMovies, CONCURRENCY, resolveMovie);

const ids = resolved.map(x => x.id);
const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
if (duplicateIds.length) {
  throw new Error(
    `Duplicate IMDb IDs resolved: ${[...new Set(duplicateIds)].join(", ")}`
  );
}

const byRelease = [...resolved].sort(
  (a, b) =>
    b._releaseTs - a._releaseTs ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
);

const byImdb = [...resolved].sort((a, b) => {
  const ar = a._rating ?? -1;
  const br = b._rating ?? -1;
  return (
    br - ar ||
    b._releaseTs - a._releaseTs ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
});

const byAlpha = [...resolved].sort((a, b) =>
  a.name.localeCompare(b.name, "en", {
    sensitivity: "base",
    numeric: true,
    ignorePunctuation: true
  })
);

const manifest = {
  id: "community.brent.mcu-films",
  version: `1.0.${autoCount}`,
  name: "Marvel",
  description:
    "All released Marvel Cinematic Universe feature films. Sort by release date, IMDb rating, or title.",
  logo:
    "https://brentjharris-code.github.io/disney-pixar-stremio/mcu/icon.svg",
  resources: ["catalog"],
  types: ["movie"],
  catalogs: [
    {
      type: "movie",
      id: CATALOG_ID,
      name: "Marvel",
      extra: [
        {
          name: "genre",
          options: SORT_OPTIONS
        }
      ]
    }
  ]
};

await writeFile(
  new URL("./manifest.json", OUT),
  JSON.stringify(manifest, null, 2) + "\n"
);

await writeFile(
  new URL(`./catalog/movie/${CATALOG_ID}.json`, OUT),
  JSON.stringify({ metas: byRelease.map(publicMeta) }, null, 2) + "\n"
);

const sortedCatalogs = new Map([
  ["Release Date", byRelease],
  ["IMDb Rating", byImdb],
  ["Alphabetical", byAlpha]
]);

for (const [label, items] of sortedCatalogs) {
  await writeFile(
    new URL(`./catalog/movie/${CATALOG_ID}/genre=${label}.json`, OUT),
    JSON.stringify({ metas: items.map(publicMeta) }, null, 2) + "\n"
  );
}

await writeFile(
  new URL("./resolved-movies.json", OUT),
  JSON.stringify(resolved, null, 2) + "\n"
);
await writeFile(new URL("./.nojekyll", OUT), "");

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#ff3434"/>
    <stop offset="55%" stop-color="#b00020"/>
    <stop offset="100%" stop-color="#52000d"/>
  </linearGradient>
  <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="7" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="512" height="512" rx="72" fill="#050505"/>
<rect x="58" y="150" width="396" height="212" rx="22" fill="url(#g)"/>
<text x="256" y="292" text-anchor="middle" font-family="Arial Black, Impact, sans-serif"
      font-size="118" font-weight="900" font-style="italic" fill="#fff" filter="url(#glow)">MCU</text>
</svg>`;

await writeFile(new URL("./icon.svg", OUT), iconSvg);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Marvel — Stremio Addon</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#090909;color:#eee;max-width:760px;margin:60px auto;padding:0 24px;line-height:1.5}
a.button{display:inline-block;background:#c6172d;color:#fff;text-decoration:none;padding:12px 18px;border-radius:9px;font-weight:700}
code{background:#222;padding:3px 6px;border-radius:5px;overflow-wrap:anywhere}.muted{color:#aaa}
</style>
</head>
<body>
<h1>Marvel</h1>
<p>${resolved.length} released MCU feature films.</p>
<p>Sort by Release Date, IMDb Rating, or Alphabetical.</p>
<p><a class="button" id="install" href="#">Install in Stremio</a></p>
<p class="muted">Manifest: <code id="manifest"></code></p>
<script>
const manifest = new URL('manifest.json', location.href).href;
document.getElementById('manifest').textContent = manifest;
document.getElementById('install').href = manifest.replace(/^https?:\\/\\//, 'stremio://');
</script>
</body>
</html>`;

await writeFile(new URL("./index.html", OUT), html);

const MARVEL = new URL("./dist/marvel-v2/", import.meta.url);
await rm(MARVEL, { recursive: true, force: true });
await mkdir(new URL("./catalog/movie/", MARVEL), { recursive: true });
await cp(new URL("./catalog/", OUT), new URL("./catalog/", MARVEL), { recursive: true });
await writeFile(new URL("./icon.svg", MARVEL), iconSvg);

const marvelManifest = {
  ...manifest,
  id: "community.brent.marvel-v2",
  version: `2.0.${autoCount}`,
  name: "Marvel",
  logo: "https://brentjharris-code.github.io/disney-pixar-stremio/marvel-v2/icon.svg",
  catalogs: manifest.catalogs.map(catalog => ({
    ...catalog,
    name: "Marvel"
  }))
};
await writeFile(
  new URL("./manifest.json", MARVEL),
  JSON.stringify(marvelManifest, null, 2) + "\n"
);

const marvelHtml = html
  .replace("<title>Marvel — Stremio Addon</title>", "<title>Marvel — Stremio Addon</title>")
  .replace("<h1>Marvel</h1>", "<h1>Marvel</h1>");
await writeFile(new URL("./index.html", MARVEL), marvelHtml);

console.log(
  `\nBuilt ${resolved.length} MCU films into dist/mcu/ with three sort modes.`
);
