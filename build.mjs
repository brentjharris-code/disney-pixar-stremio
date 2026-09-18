import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { movies } from "./movies.mjs";

const autoReleases = JSON.parse(await readFile(new URL("./auto-releases.json", import.meta.url), "utf8"));
const allMovies = [...movies, ...(autoReleases.disneyPixar ?? [])];
const autoCount = (autoReleases.disneyPixar ?? []).length;

const OUT = new URL("./dist/", import.meta.url);
const CONCURRENCY = 6;

const CATALOG_ID = "disney-pixar";
const SORT_OPTIONS = ["Release Date", "IMDb Rating", "Alphabetical"];
const ORDER_OPTIONS = ["Descending", "Ascending"];

function normalize(s = "") {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/[·.:'’!?,()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getYear(meta) {
  const raw = String(meta.releaseInfo ?? meta.year ?? "");
  const match = raw.match(/\b(18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function score(meta, wantedTitle, wantedYear) {
  const a = normalize(meta.name);
  const b = normalize(wantedTitle);
  const y = getYear(meta);
  let n = 0;
  if (a === b) n += 120;
  else if (a.includes(b) || b.includes(a)) n += 45;
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
        headers: { "user-agent": "DisneyPixarStremioCatalog/1.1" }
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
  const url = `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encoded}.json`;
  const data = await fetchJson(url);
  return Array.isArray(data.metas) ? data.metas : [];
}

async function getCinemetaMeta(id) {
  try {
    const data = await fetchJson(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`, 3);
    return data?.meta ?? {};
  } catch (err) {
    console.warn(`Could not fetch full metadata for ${id}: ${err.message}`);
    return {};
  }
}

function releaseTimestamp(meta, fallbackYear) {
  const raw = meta.released ?? meta.releaseDate ?? null;
  const ts = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ts) ? ts : Date.UTC(fallbackYear, 0, 1);
}

function numericRating(value) {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}

async function resolveMovie(movie) {
  const queries = [movie.title, ...(movie.aliases ?? [])];
  let candidates = [];

  for (const query of queries) {
    const metas = await searchCinemeta(query);
    candidates.push(...metas);
    const best = metas
      .map(meta => ({ meta, score: score(meta, movie.title, movie.year) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best?.score >= 150) {
      candidates = metas;
      break;
    }
  }

  const ranked = candidates
    .map(meta => ({ meta, score: score(meta, movie.title, movie.year) }))
    .filter(x => String(x.meta.id ?? "").startsWith("tt"))
    .sort((a, b) => b.score - a.score);

  const winner = ranked[0];
  const winnerName = normalize(winner?.meta?.name ?? "");
  const wantedName = normalize(movie.title);
  const titleCompatible =
    winnerName === wantedName ||
    winnerName.includes(wantedName) ||
    wantedName.includes(winnerName);

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
  const released = details.released ?? null;

  return {
    id,
    type: "movie",
    name: movie.title,
    releaseInfo: String(movie.year),
    poster: details.poster || winner.meta.poster || `https://images.metahub.space/poster/medium/${id}/img`,
    ...(rating !== null ? { imdbRating: rating.toFixed(1) } : {}),
    _studio: movie.studio,
    _resolvedName: winner.meta.name,
    _resolvedYear: getYear(winner.meta),
    _score: winner.score,
    _rating: rating,
    _released: released,
    _releaseTs: releaseTimestamp(details, movie.year)
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
      process.stdout.write(`Resolved ${i + 1}/${items.length}: ${items[i].title}\n`);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

function publicMeta(item) {
  const {
    _studio,
    _resolvedName,
    _resolvedYear,
    _score,
    _rating,
    _released,
    _releaseTs,
    ...meta
  } = item;
  return meta;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(new URL("./catalog/movie/", OUT), { recursive: true });

if (allMovies.length < 95) {
  throw new Error(`Expected at least 95 released Disney/Pixar features, found ${allMovies.length}.`);
}

const resolved = await mapPool(allMovies, CONCURRENCY, resolveMovie);
const ids = resolved.map(x => x.id);
const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
if (duplicateIds.length) {
  throw new Error(`Duplicate IMDb IDs resolved: ${[...new Set(duplicateIds)].join(", ")}`);
}

const byRelease = [...resolved].sort((a, b) =>
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
  id: "community.brent.disney-pixar-canon",
  version: `1.2.${autoCount}`,
  name: "Disney/Pixar",
  description: "All released Walt Disney Animation Studios and Pixar feature films. Sort by release date, IMDb rating, or title.",
  logo: "https://brentjharris-code.github.io/disney-pixar-stremio/icon.svg",
  resources: ["catalog"],
  types: ["movie"],
  catalogs: [
    {
      type: "movie",
      id: CATALOG_ID,
      name: "Disney/Pixar",
      extra: [
        {
          name: "genre",
          isRequired: true,
          options: SORT_OPTIONS
        },
        {
          name: "order",
          isRequired: true,
          options: ORDER_OPTIONS
        }
      ]
    }
  ]
};

await writeFile(new URL("./manifest.json", OUT), JSON.stringify(manifest, null, 2) + "\n");

// Default Home catalog: release date, newest first.
await writeFile(
  new URL(`./catalog/movie/${CATALOG_ID}.json`, OUT),
  JSON.stringify({ metas: byRelease.map(publicMeta) }, null, 2) + "\n"
);

// Stremio exposes catalog "extra" options through its Discover dropdown.
// Static GitHub Pages can serve these because each option is pre-generated.
await mkdir(new URL(`./catalog/movie/${CATALOG_ID}/`, OUT), { recursive: true });

const sortedCatalogs = new Map([
  ["Release Date", {
    Descending: byRelease,
    Ascending: [...byRelease].reverse()
  }],
  ["IMDb Rating", {
    Descending: byImdb,
    Ascending: [...byImdb].reverse()
  }],
  ["Alphabetical", {
    Descending: [...byAlpha].reverse(),
    Ascending: byAlpha
  }]
]);

for (const [label, orders] of sortedCatalogs) {
  const legacyDefault =
    label === "Alphabetical" ? orders.Ascending : orders.Descending;

  await writeFile(
    new URL(`./catalog/movie/${CATALOG_ID}/genre=${label}.json`, OUT),
    JSON.stringify({ metas: legacyDefault.map(publicMeta) }, null, 2) + "\n"
  );

  for (const order of ORDER_OPTIONS) {
    const items = orders[order];

    await writeFile(
      new URL(`./catalog/movie/${CATALOG_ID}/genre=${label}&order=${order}.json`, OUT),
      JSON.stringify({ metas: items.map(publicMeta) }, null, 2) + "\n"
    );

    await writeFile(
      new URL(`./catalog/movie/${CATALOG_ID}/order=${order}&genre=${label}.json`, OUT),
      JSON.stringify({ metas: items.map(publicMeta) }, null, 2) + "\n"
    );
  }
}

for (const order of ORDER_OPTIONS) {
  await writeFile(
    new URL(`./catalog/movie/${CATALOG_ID}/order=${order}.json`, OUT),
    JSON.stringify({ metas: sortedCatalogs.get("Release Date")[order].map(publicMeta) }, null, 2) + "\n"
  );
}

await writeFile(
  new URL("./resolved-movies.json", OUT),
  JSON.stringify(resolved, null, 2) + "\n"
);
await writeFile(new URL("./.nojekyll", OUT), "");

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs>
  <linearGradient id="neon" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#39d6ff"/>
    <stop offset="48%" stop-color="#785cff"/>
    <stop offset="100%" stop-color="#ff3aa7"/>
  </linearGradient>
  <linearGradient id="neon2" x1="1" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#25f2ff"/>
    <stop offset="55%" stop-color="#6c4dff"/>
    <stop offset="100%" stop-color="#ff2f9b"/>
  </linearGradient>
  <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="7" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="512" height="512" rx="72" fill="#020206"/>
<g filter="url(#glow)" text-anchor="middle">
  <text x="256" y="235" font-size="126" font-family="Brush Script MT, Segoe Script, cursive" font-weight="700"
        fill="url(#neon)" stroke="url(#neon2)" stroke-width="2">Disney</text>
  <text x="256" y="345" font-size="82" letter-spacing="9" font-family="Georgia, Times New Roman, serif" font-weight="700"
        fill="url(#neon2)" stroke="url(#neon)" stroke-width="1.5">PIXAR</text>
</g>
</svg>`;
await writeFile(new URL("./icon.svg", OUT), iconSvg);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Disney/Pixar — Stremio Addon</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;max-width:760px;margin:60px auto;padding:0 24px;line-height:1.5}
a.button{display:inline-block;background:#7b5cff;color:#fff;text-decoration:none;padding:12px 18px;border-radius:9px;font-weight:700;margin-right:10px}
code{background:#222;padding:3px 6px;border-radius:5px;overflow-wrap:anywhere}.muted{color:#aaa}
</style>
</head>
<body>
<h1>Disney/Pixar</h1>
<p>${resolved.length} released Walt Disney Animation Studios and Pixar feature films.</p>
<p>One catalog with sorting for Release Date, IMDb Rating, and Alphabetical.</p>
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

// Publish a fresh v2 endpoint with a different addon ID so Stremio treats it
// as a completely new addon instead of reusing cached manifest data.
const V2 = new URL("./v2/", OUT);
await mkdir(new URL("./catalog/", V2), { recursive: true });
await cp(new URL("./catalog/", OUT), new URL("./catalog/", V2), { recursive: true });
await writeFile(new URL("./icon.svg", V2), iconSvg);

const v2Manifest = {
  ...manifest,
  id: "community.brent.disney-pixar-canon-v2",
  version: `2.0.${autoCount}`,
  name: "Disney + Pixar Canon v2",
  logo: "https://brentjharris-code.github.io/disney-pixar-stremio/v2/icon.svg"
};
await writeFile(
  new URL("./manifest.json", V2),
  JSON.stringify(v2Manifest, null, 2) + "\n"
);

const v2Html = html
  .replace("<title>Disney + Pixar Canon — Stremio Addon</title>", "<title>Disney + Pixar Canon v2 — Stremio Addon</title>")
  .replace("<h1>Disney + Pixar Canon</h1>", "<h1>Disney + Pixar Canon v2</h1>");
await writeFile(new URL("./index.html", V2), v2Html);

const CLEAN = new URL("./disney-pixar-v3/", OUT);
await rm(CLEAN, { recursive: true, force: true });
await mkdir(new URL("./catalog/", CLEAN), { recursive: true });
await cp(new URL("./catalog/", OUT), new URL("./catalog/", CLEAN), { recursive: true });
await writeFile(new URL("./icon.svg", CLEAN), iconSvg);

const cleanManifest = {
  ...manifest,
  id: "community.brent.disney-pixar-v3",
  version: `3.0.${autoCount}`,
  name: "Disney/Pixar",
  logo: "https://brentjharris-code.github.io/disney-pixar-stremio/disney-pixar-v3/icon.svg",
  catalogs: manifest.catalogs.map(catalog => ({
    ...catalog,
    name: "Disney/Pixar"
  }))
};
await writeFile(
  new URL("./manifest.json", CLEAN),
  JSON.stringify(cleanManifest, null, 2) + "\n"
);

const cleanHtml = html
  .replace("<title>Disney/Pixar — Stremio Addon</title>", "<title>Disney/Pixar — Stremio Addon</title>")
  .replace("<h1>Disney/Pixar</h1>", "<h1>Disney/Pixar</h1>");
await writeFile(new URL("./index.html", CLEAN), cleanHtml);

const CLEAN_V4 = new URL("./disney-pixar-v4/", OUT);
await rm(CLEAN_V4, { recursive: true, force: true });
await mkdir(new URL("./catalog/", CLEAN_V4), { recursive: true });
await cp(new URL("./catalog/", OUT), new URL("./catalog/", CLEAN_V4), { recursive: true });
await writeFile(new URL("./icon.svg", CLEAN_V4), iconSvg);

const cleanV4Manifest = {
  ...manifest,
  id: "community.brent.disney-pixar-v4",
  version: `4.0.${autoCount}`,
  name: "Disney/Pixar",
  logo: "https://brentjharris-code.github.io/disney-pixar-stremio/disney-pixar-v4/icon.svg",
  catalogs: manifest.catalogs.map(catalog => ({
    ...catalog,
    name: "Disney/Pixar"
  }))
};
await writeFile(
  new URL("./manifest.json", CLEAN_V4),
  JSON.stringify(cleanV4Manifest, null, 2) + "\n"
);
await writeFile(new URL("./index.html", CLEAN_V4), cleanHtml);

console.log(`\nBuilt ${resolved.length} movies with three sort modes.`);
console.log("Release Date: newest to oldest (default/Home)");
console.log("IMDb Rating: highest to lowest");
console.log("Alphabetical: A to Z");
console.log("Addon icon: icon.svg");
