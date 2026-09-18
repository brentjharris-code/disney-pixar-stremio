import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { starWarsContent } from "./star-wars-content.mjs";

const autoReleases = JSON.parse(
  await readFile(new URL("./auto-releases.json", import.meta.url), "utf8")
);

const allContent = [
  ...starWarsContent,
  ...(autoReleases.starWarsMovies ?? []).map(x => ({ ...x, type: "movie" })),
  ...(autoReleases.starWarsSeries ?? []).map(x => ({ ...x, type: "series" }))
];

const autoCount =
  (autoReleases.starWarsMovies ?? []).length +
  (autoReleases.starWarsSeries ?? []).length;

const OUT = new URL("./dist/star-wars/", import.meta.url);
const CONCURRENCY = 6;
const SORT_OPTIONS = ["Release Date", "IMDb Rating", "Alphabetical"];

const CATALOGS = {
  movie: "star-wars-movies-specials",
  series: "star-wars-series"
};

function normalize(s = "") {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[·.:'’!?,()*–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getYear(meta) {
  const raw = String(meta.releaseInfo ?? meta.year ?? "");
  const match = raw.match(/\b(18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function score(meta, item) {
  const actual = normalize(meta.name);
  const names = [item.title, ...(item.aliases ?? [])].map(normalize);
  const y = getYear(meta);
  let n = 0;

  if (names.some(name => actual === name)) n += 120;
  else if (names.some(name => actual.includes(name) || name.includes(actual))) n += 45;

  if (y === item.year) n += 70;
  else if (y && Math.abs(y - item.year) === 1) n += 20;

  if (meta.type === item.type) n += 10;
  if (String(meta.id ?? "").startsWith("tt")) n += 10;
  return n;
}

async function fetchJson(url, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "StarWarsEverythingStremioCatalog/2.0" }
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

async function searchCinemeta(query, type) {
  const encoded = encodeURIComponent(query);
  const data = await fetchJson(
    `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encoded}.json`
  );
  return Array.isArray(data.metas) ? data.metas : [];
}

async function getCinemetaMeta(id, type) {
  try {
    const data = await fetchJson(
      `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`,
      3
    );
    return data?.meta ?? {};
  } catch (err) {
    console.warn(`Could not fetch full metadata for ${type}/${id}: ${err.message}`);
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

async function resolveItem(item) {
  if (item.id && String(item.id).startsWith("tt")) {
    const details = await getCinemetaMeta(item.id, item.type);
    const rating = numericRating(details.imdbRating);
    return {
      id: item.id,
      type: item.type,
      name: item.title,
      releaseInfo: String(item.year),
      poster:
        details.poster ||
        `https://images.metahub.space/poster/medium/${item.id}/img`,
      ...(rating !== null ? { imdbRating: rating.toFixed(1) } : {}),
      _rating: rating,
      _releaseTs: releaseTimestamp(details, item.year),
      _resolvedName: details.name ?? item.title,
      _score: 999
    };
  }

  const queries = [item.title, ...(item.aliases ?? [])];
  let candidates = [];

  for (const query of queries) {
    const metas = await searchCinemeta(query, item.type);
    candidates.push(...metas);

    const best = metas
      .map(meta => ({ meta, score: score(meta, item) }))
      .sort((a, b) => b.score - a.score)[0];

    if (best?.score >= 150) {
      candidates = metas;
      break;
    }
  }

  const ranked = candidates
    .map(meta => ({ meta, score: score(meta, item) }))
    .filter(x => String(x.meta.id ?? "").startsWith("tt"))
    .sort((a, b) => b.score - a.score);

  const winner = ranked[0];
  const winnerName = normalize(winner?.meta?.name ?? "");
  const compatibleNames = [item.title, ...(item.aliases ?? [])].map(normalize);
  const titleCompatible = compatibleNames.some(
    wanted =>
      winnerName === wanted ||
      winnerName.includes(wanted) ||
      wanted.includes(winnerName)
  );

  if (!winner || winner.score < 100) {
    if (!titleCompatible || winner.score < 55) {
      throw new Error(
        `Could not confidently resolve ${item.type} "${item.title}" (${item.year}). Best score: ${winner?.score ?? "none"}`
      );
    }
    console.warn(
      `Accepted title-only match for ${item.title} (${item.year}): "${winner.meta.name}" [${winner.meta.id}], score ${winner.score}`
    );
  }

  const id = winner.meta.id;
  let details = winner.meta;

  if (!winner.meta.imdbRating || !winner.meta.released) {
    details = { ...winner.meta, ...(await getCinemetaMeta(id, item.type)) };
  }

  const rating = numericRating(details.imdbRating);

  return {
    id,
    type: item.type,
    name: item.title,
    releaseInfo: String(item.year),
    poster:
      details.poster ||
      winner.meta.poster ||
      `https://images.metahub.space/poster/medium/${id}/img`,
    ...(rating !== null ? { imdbRating: rating.toFixed(1) } : {}),
    _rating: rating,
    _releaseTs: releaseTimestamp(details, item.year),
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
        `Resolved Star Wars ${i + 1}/${items.length}: [${items[i].type}] ${items[i].title}\n`
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

function sortRelease(items) {
  return [...items].sort(
    (a, b) =>
      b._releaseTs - a._releaseTs ||
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
}

function sortImdb(items) {
  return [...items].sort((a, b) => {
    const ar = a._rating ?? -1;
    const br = b._rating ?? -1;
    return (
      br - ar ||
      b._releaseTs - a._releaseTs ||
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    );
  });
}

function sortAlpha(items) {
  return [...items].sort((a, b) =>
    a.name.localeCompare(b.name, "en", {
      sensitivity: "base",
      numeric: true,
      ignorePunctuation: true
    })
  );
}

await rm(OUT, { recursive: true, force: true });

const movieItems = allContent.filter(x => x.type === "movie");
const seriesItems = allContent.filter(x => x.type === "series");

if (movieItems.length < 20 || seriesItems.length < 25) {
  throw new Error(
    `Star Wars catalog unexpectedly small: ${movieItems.length} movies/specials, ${seriesItems.length} series.`
  );
}

const resolved = await mapPool(allContent, CONCURRENCY, resolveItem);

const idsByType = new Map();
for (const item of resolved) {
  const key = `${item.type}:${item.id}`;
  if (idsByType.has(key)) {
    throw new Error(
      `Duplicate resolved ID ${key} for "${idsByType.get(key)}" and "${item.name}".`
    );
  }
  idsByType.set(key, item.name);
}

const resolvedMovies = resolved.filter(x => x.type === "movie");
const resolvedSeries = resolved.filter(x => x.type === "series");

const manifest = {
  id: "community.brent.star-wars-everything",
  version: `2.0.${autoCount}`,
  name: "Star Wars — Everything",
  description:
    "Official Star Wars screen content: movies, TV movies, specials, live-action and animated series, LEGO, canon and Legends.",
  logo:
    "https://brentjharris-code.github.io/disney-pixar-stremio/star-wars/icon.svg",
  resources: ["catalog"],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: CATALOGS.movie,
      name: "Star Wars — Movies & Specials",
      extra: [{ name: "genre", options: SORT_OPTIONS }]
    },
    {
      type: "series",
      id: CATALOGS.series,
      name: "Star Wars — Series",
      extra: [{ name: "genre", options: SORT_OPTIONS }]
    }
  ]
};

await mkdir(new URL(`./catalog/movie/${CATALOGS.movie}/`, OUT), { recursive: true });
await mkdir(new URL(`./catalog/series/${CATALOGS.series}/`, OUT), { recursive: true });

await writeFile(
  new URL("./manifest.json", OUT),
  JSON.stringify(manifest, null, 2) + "\n"
);

for (const [type, id, items] of [
  ["movie", CATALOGS.movie, resolvedMovies],
  ["series", CATALOGS.series, resolvedSeries]
]) {
  const sorted = new Map([
    ["Release Date", sortRelease(items)],
    ["IMDb Rating", sortImdb(items)],
    ["Alphabetical", sortAlpha(items)]
  ]);

  await writeFile(
    new URL(`./catalog/${type}/${id}.json`, OUT),
    JSON.stringify({ metas: sorted.get("Release Date").map(publicMeta) }, null, 2) + "\n"
  );

  for (const [label, list] of sorted) {
    await writeFile(
      new URL(`./catalog/${type}/${id}/genre=${label}.json`, OUT),
      JSON.stringify({ metas: list.map(publicMeta) }, null, 2) + "\n"
    );
  }
}

await writeFile(
  new URL("./resolved-content.json", OUT),
  JSON.stringify(resolved, null, 2) + "\n"
);
await writeFile(new URL("./.nojekyll", OUT), "");

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#fff77a"/>
    <stop offset="45%" stop-color="#ffd928"/>
    <stop offset="100%" stop-color="#d79d00"/>
  </linearGradient>
  <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="6" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="512" height="512" rx="72" fill="#020204"/>
<g text-anchor="middle" fill="none" stroke="url(#gold)" stroke-width="10" filter="url(#glow)">
  <text x="256" y="225" font-family="Arial Black, Impact, sans-serif" font-size="122" font-weight="900" letter-spacing="-8">STAR</text>
  <text x="256" y="350" font-family="Arial Black, Impact, sans-serif" font-size="118" font-weight="900" letter-spacing="-8">WARS</text>
</g>
</svg>`;

await writeFile(new URL("./icon.svg", OUT), iconSvg);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Star Wars — Everything — Stremio Addon</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#050506;color:#eee;max-width:760px;margin:60px auto;padding:0 24px;line-height:1.5}
a.button{display:inline-block;background:#e1b915;color:#111;text-decoration:none;padding:12px 18px;border-radius:9px;font-weight:800}
code{background:#222;padding:3px 6px;border-radius:5px;overflow-wrap:anywhere}.muted{color:#aaa}
</style>
</head>
<body>
<h1>Star Wars — Everything</h1>
<p>${resolvedMovies.length} movies/specials and ${resolvedSeries.length} series.</p>
<p>Includes theatrical films, TV movies, specials, live-action and animation, LEGO, canon and Legends.</p>
<p>Each catalog can be sorted by Release Date, IMDb Rating, or Alphabetical.</p>
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

console.log(
  `\nBuilt Star Wars Everything: ${resolvedMovies.length} movies/specials + ${resolvedSeries.length} series.`
);
