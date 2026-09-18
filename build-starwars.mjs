import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
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
const POSTER_BASE = "https://brentjharris-code.github.io/disney-pixar-stremio/star-wars/posters";
const CONCURRENCY = 6;
const SORT_OPTIONS = ["Release Date", "IMDb Rating", "Alphabetical"];

const CATALOGS = {
  movie: "star-wars-complete-movies-specials",
  series: "star-wars-complete-series"
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

function customId(item) {
  const slug = normalize(item.title).replace(/\s+/g, "-");
  return `sw-${item.type}-${slug}`;
}


function posterStem(item) {
  const slug = normalize(item.title)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return `${item.type}-${item.year}-${slug || "untitled"}`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function titleSeed(text) {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function generateFallbackPosterPng(item) {
  const width = 420;
  const height = 630;
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  const seed = titleSeed(`${item.type}:${item.year}:${item.title}`);

  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      const edge = x < 7 || x >= width - 7 || y < 7 || y >= height - 7;
      const glow = Math.max(0, 1 - Math.abs(y - height * 0.52) / (height * 0.52));
      let r = Math.round(3 + glow * 8);
      let g = Math.round(5 + glow * 7);
      let b = Math.round(12 + glow * 18);

      const n = (Math.imul(x + 1, 1103515245) ^ Math.imul(y + 1, 12345) ^ seed) >>> 0;
      if (!edge && n % 997 < 2) {
        r = 235;
        g = 235;
        b = 220;
      }

      if (edge) {
        r = 232;
        g = 190;
        b = 28;
      }

      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function sniffImageExtension(buffer, contentType = "") {
  const ct = String(contentType).toLowerCase();
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

async function fetchPosterBinary(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "StarWarsEverythingStremioCatalog/PosterCache" },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 1000) return null;
    const ext = sniffImageExtension(buffer, res.headers.get("content-type"));
    if (!ext) return null;
    return { buffer, ext };
  } catch {
    return null;
  }
}

async function materializePoster(item, candidates = []) {
  const stem = posterStem(item);
  const unique = [...new Set(candidates.filter(Boolean))];

  for (const candidate of unique) {
    const image = await fetchPosterBinary(candidate);
    if (!image) continue;
    const filename = `${stem}.${image.ext}`;
    await writeFile(new URL(`./posters/${filename}`, OUT), image.buffer);
    return {
      url: `${POSTER_BASE}/${filename}`,
      fallback: false
    };
  }

  const filename = `${stem}.png`;
  await writeFile(
    new URL(`./posters/${filename}`, OUT),
    generateFallbackPosterPng(item)
  );
  return {
    url: `${POSTER_BASE}/${filename}`,
    fallback: true
  };
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
  if (item.forceCustom) {
    const id = customId(item);
    const poster = await materializePoster(item, [item.poster]);
    return {
      id,
      type: item.type,
      name: item.title,
      releaseInfo: String(item.year),
      poster: poster.url,
      description: item.description || "Official Star Wars screen content.",
      _rating: null,
      _releaseTs: Date.UTC(item.year, 0, 1),
      _resolvedName: item.title,
      _score: 0,
      _custom: true,
      _posterFallback: poster.fallback
    };
  }

  if (item.id && String(item.id).startsWith("tt")) {
    const details = await getCinemetaMeta(item.id, item.type);
    const rating = numericRating(details.imdbRating);
    const poster = await materializePoster(item, [
      item.poster,
      details.poster,
      `https://images.metahub.space/poster/medium/${item.id}/img`
    ]);
    return {
      id: item.id,
      type: item.type,
      name: item.title,
      releaseInfo: String(item.year),
      poster: poster.url,
      ...(rating !== null ? { imdbRating: rating.toFixed(1) } : {}),
      _rating: rating,
      _releaseTs: releaseTimestamp(details, item.year),
      _resolvedName: details.name ?? item.title,
      _score: 999,
      _posterFallback: poster.fallback
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
      if (item.allowCustom) {
        const id = customId(item);
        console.warn(
          `Using catalog-only Star Wars metadata for ${item.title} (${item.year}); no standalone Cinemeta/IMDb match.`
        );
        const poster = await materializePoster(item, [item.poster]);
        return {
          id,
          type: item.type,
          name: item.title,
          releaseInfo: String(item.year),
          poster: poster.url,
          description: item.description || "Official Star Wars screen content.",
          _rating: null,
          _releaseTs: Date.UTC(item.year, 0, 1),
          _resolvedName: item.title,
          _score: 0,
          _custom: true,
          _posterFallback: poster.fallback
        };
      }
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
  const poster = await materializePoster(item, [
    item.poster,
    details.poster,
    winner.meta.poster,
    `https://images.metahub.space/poster/medium/${id}/img`
  ]);

  return {
    id,
    type: item.type,
    name: item.title,
    releaseInfo: String(item.year),
    poster: poster.url,
    ...(rating !== null ? { imdbRating: rating.toFixed(1) } : {}),
    _rating: rating,
    _releaseTs: releaseTimestamp(details, item.year),
    _resolvedName: winner.meta.name,
    _score: winner.score,
    _posterFallback: poster.fallback
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
  const {
    _rating,
    _releaseTs,
    _resolvedName,
    _score,
    _custom,
    _posterFallback,
    ...meta
  } = item;
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
await mkdir(new URL("./posters/", OUT), { recursive: true });

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

for (const item of resolved) {
  if (!item.poster || !item.poster.startsWith(`${POSTER_BASE}/`)) {
    throw new Error(`Poster invariant failed for ${item.type} "${item.name}".`);
  }
}
const generatedPosterCount = resolved.filter(x => x._posterFallback).length;

const manifest = {
  id: "community.brent.star-wars-everything",
  version: `2.1.${autoCount}`,
  name: "Star Wars — Everything",
  description:
    "Official Star Wars screen content: movies, TV movies, specials, live-action and animated series, LEGO, canon and Legends.",
  logo:
    "https://brentjharris-code.github.io/disney-pixar-stremio/star-wars/icon.svg",
  resources: [
    "catalog",
    { name: "meta", types: ["movie", "series"], idPrefixes: ["sw-"] }
  ],
  types: ["series", "movie"],
  catalogs: [
    {
      type: "series",
      id: CATALOGS.series,
      name: "STAR WARS — EVERYTHING: SERIES",
      extra: [{ name: "genre", options: SORT_OPTIONS }]
    },
    {
      type: "movie",
      id: CATALOGS.movie,
      name: "STAR WARS — EVERYTHING: MOVIES, SPECIALS & DOCS",
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

for (const item of resolved.filter(x => x._custom)) {
  const dir = new URL(`./meta/${item.type}/`, OUT);
  await mkdir(dir, { recursive: true });
  await writeFile(
    new URL(`./meta/${item.type}/${item.id}.json`, OUT),
    JSON.stringify({ meta: publicMeta(item) }, null, 2) + "\n"
  );
}

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

// Publish the expanded catalog at a fresh URL so existing Stremio installs
// cannot reuse the earlier films-only manifest from cache.
const FRESH = new URL("./dist/star-wars-everything/", import.meta.url);
await rm(FRESH, { recursive: true, force: true });
await cp(OUT, FRESH, { recursive: true });

const COMPLETE = new URL("./dist/star-wars-complete/", import.meta.url);
await rm(COMPLETE, { recursive: true, force: true });
await cp(OUT, COMPLETE, { recursive: true });
const completeManifest = {
  ...manifest,
  id: "community.brent.star-wars-complete-v3",
  version: `3.1.${autoCount}`,
  name: "Star Wars — COMPLETE: Movies + Series",
  logo: "https://brentjharris-code.github.io/disney-pixar-stremio/star-wars-complete/icon.svg"
};
await writeFile(
  new URL("./manifest.json", COMPLETE),
  JSON.stringify(completeManifest, null, 2) + "\n"
);

const COMPLETE_V4 = new URL("./dist/star-wars-complete-v4/", import.meta.url);
await rm(COMPLETE_V4, { recursive: true, force: true });
await cp(OUT, COMPLETE_V4, { recursive: true });
const completeV4Manifest = {
  ...manifest,
  id: "community.brent.star-wars-complete-v4",
  version: `4.1.${autoCount}`,
  name: "Star Wars — COMPLETE v4",
  logo: "https://brentjharris-code.github.io/disney-pixar-stremio/star-wars-complete-v4/icon.svg"
};
await writeFile(
  new URL("./manifest.json", COMPLETE_V4),
  JSON.stringify(completeV4Manifest, null, 2) + "\n"
);

const COMPLETE_V5 = new URL("./dist/star-wars-complete-v5/", import.meta.url);
await rm(COMPLETE_V5, { recursive: true, force: true });
await cp(OUT, COMPLETE_V5, { recursive: true });
const completeV5Manifest = {
  ...manifest,
  id: "community.brent.star-wars-complete-v5",
  version: `5.0.${autoCount}`,
  name: "Star Wars — COMPLETE v5",
  logo: "https://brentjharris-code.github.io/disney-pixar-stremio/star-wars-complete-v5/icon.svg"
};
await writeFile(
  new URL("./manifest.json", COMPLETE_V5),
  JSON.stringify(completeV5Manifest, null, 2) + "\n"
);

console.log(
  `\nBuilt Star Wars Everything: ${resolvedMovies.length} movies/specials + ${resolvedSeries.length} series.`
);
console.log(
  `Poster cache: ${resolved.length - generatedPosterCount} downloaded + ${generatedPosterCount} generated fallbacks; every catalog item now points to a local GitHub Pages poster.`
);
