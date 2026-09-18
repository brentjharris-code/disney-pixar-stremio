import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
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
const POSTER_BASE = "https://brentjharris-code.github.io/disney-pixar-stremio/star-wars/posters-v3";
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

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapPosterTitle(title, maxChars = 22) {
  const clean = String(title)
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const words = clean.split(" ");
  const lines = [];
  let line = "";

  for (const word of words) {
    const proposed = line ? line + " " + word : word;
    if (proposed.length <= maxChars) {
      line = proposed;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

async function await generateFallbackPosterPng(item) {
  const width = 600;
  const height = 900;
  const lines = wrapPosterTitle(item.title);
  const titleSize = lines.length >= 5 ? 42 : lines.length >= 4 ? 48 : 54;
  const lineHeight = Math.round(titleSize * 1.18);
  const titleBlockHeight = lines.length * lineHeight;
  const titleStart = Math.round(470 - titleBlockHeight / 2);

  const titleSvg = lines.map((line, i) =>
    '<text x="300" y="' + (titleStart + i * lineHeight) +
    '" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="' +
    titleSize + '" font-weight="700" fill="#f5f5f2">' +
    xmlEscape(line) + '</text>'
  ).join("");

  const typeLabel = item.type === "series" ? "SERIES" : "MOVIE / SPECIAL";

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">' +
    '<defs>' +
      '<radialGradient id="bg" cx="50%" cy="42%" r="75%">' +
        '<stop offset="0%" stop-color="#17213c"/>' +
        '<stop offset="58%" stop-color="#080b15"/>' +
        '<stop offset="100%" stop-color="#020307"/>' +
      '</radialGradient>' +
      '<filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
    '</defs>' +
    '<rect width="600" height="900" fill="url(#bg)"/>' +
    '<g fill="#f6d32d" opacity="0.9">' +
      '<circle cx="78" cy="155" r="2"/><circle cx="510" cy="118" r="2"/><circle cx="135" cy="705" r="2"/>' +
      '<circle cx="468" cy="654" r="1.8"/><circle cx="350" cy="210" r="1.5"/><circle cx="236" cy="760" r="1.5"/>' +
    '</g>' +
    '<rect x="14" y="14" width="572" height="872" rx="18" fill="none" stroke="#f0ca25" stroke-width="7"/>' +
    '<text x="300" y="130" text-anchor="middle" font-family="Arial Black,Impact,sans-serif" font-size="72" font-weight="900" fill="#f3cf27" filter="url(#glow)">STAR</text>' +
    '<text x="300" y="202" text-anchor="middle" font-family="Arial Black,Impact,sans-serif" font-size="72" font-weight="900" fill="#f3cf27" filter="url(#glow)">WARS</text>' +
    '<line x1="70" x2="530" y1="245" y2="245" stroke="#f0ca25" stroke-width="3" opacity="0.8"/>' +
    titleSvg +
    '<line x1="110" x2="490" y1="690" y2="690" stroke="#73798a" stroke-width="2"/>' +
    '<text x="300" y="752" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="30" font-weight="700" letter-spacing="4" fill="#aeb4c2">' +
      xmlEscape(typeLabel) + '</text>' +
    '<text x="300" y="820" text-anchor="middle" font-family="Arial Black,Impact,sans-serif" font-size="46" font-weight="900" fill="#f3cf27">' +
      xmlEscape(item.year) + '</text>' +
    '</svg>';

  return await sharp(Buffer.from(svg)).png().toBuffer();
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
    await writeFile(new URL(`./posters-v3/${filename}`, OUT), image.buffer);
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
await mkdir(new URL("./posters-v3/", OUT), { recursive: true });

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
  version: `2.2.${autoCount}`,
  name: "Star Wars — Everything",
  description:
    "Official Star Wars screen content: movies, TV movies, specials, live-action and animated series, LEGO, canon and Legends.",
  logo:
    "https://brentjharris-code.github.io/disney-pixar-stremio/star-wars/icon.svg",
  resources: [
    "catalog",
    { name: "meta", types: ["movie", "series"], idPrefixes: ["sw-"] },
    { name: "stream", types: ["movie", "series"], idPrefixes: ["sw-"] }
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

  const streamDir = new URL(`./stream/${item.type}/`, OUT);
  await mkdir(streamDir, { recursive: true });
  const query = encodeURIComponent(item.name + " Star Wars official");
  const starWarsQuery = encodeURIComponent("site:starwars.com " + item.name);

  await writeFile(
    new URL(`./stream/${item.type}/${item.id}.json`, OUT),
    JSON.stringify(
      {
        streams: [
          {
            name: "Official / Web",
            title: "Find official Star Wars source",
            externalUrl: `https://www.google.com/search?q=${starWarsQuery}`
          },
          {
            name: "YouTube",
            title: "Find this Star Wars title on YouTube",
            externalUrl: `https://www.youtube.com/results?search_query=${query}`
          }
        ]
      },
      null,
      2
    ) + "\n"
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
  version: `3.2.${autoCount}`,
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
  version: `4.2.${autoCount}`,
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

const COMPLETE_V6 = new URL("./dist/star-wars-complete-v6/", import.meta.url);
await rm(COMPLETE_V6, { recursive: true, force: true });
await cp(OUT, COMPLETE_V6, { recursive: true });
const completeV6Manifest = {
  ...manifest,
  id: "community.brent.star-wars-complete-v6",
  version: `6.0.${autoCount}`,
  name: "Star Wars — COMPLETE v6",
  logo: "https://brentjharris-code.github.io/disney-pixar-stremio/star-wars-complete-v6/icon.svg"
};
await writeFile(
  new URL("./manifest.json", COMPLETE_V6),
  JSON.stringify(completeV6Manifest, null, 2) + "\n"
);

console.log(
  `\nBuilt Star Wars Everything: ${resolvedMovies.length} movies/specials + ${resolvedSeries.length} series.`
);
console.log(
  `Poster cache: ${resolved.length - generatedPosterCount} downloaded + ${generatedPosterCount} generated fallbacks; every catalog item now points to a local GitHub Pages poster.`
);
