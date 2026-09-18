import { mkdir, rm, writeFile } from "node:fs/promises";
import { movies } from "./movies.mjs";

const OUT = new URL("./dist/", import.meta.url);
const CATALOG_ID = "disney-pixar";
const CONCURRENCY = 6;

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
        headers: { "user-agent": "DisneyPixarStremioCatalog/1.0" }
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
  if (!winner || winner.score < 100) {
    throw new Error(`Could not confidently resolve ${movie.title} (${movie.year}). Best score: ${winner?.score ?? "none"}`);
  }

  const id = winner.meta.id;
  return {
    id,
    type: "movie",
    name: movie.title,
    releaseInfo: String(movie.year),
    poster: winner.meta.poster || `https://images.metahub.space/poster/medium/${id}/img`,
    _studio: movie.studio,
    _resolvedName: winner.meta.name,
    _resolvedYear: getYear(winner.meta),
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
      process.stdout.write(`Resolved ${i + 1}/${items.length}: ${items[i].title}\n`);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(new URL("./catalog/movie/", OUT), { recursive: true });

if (movies.length !== 95) {
  throw new Error(`Expected 95 released Disney/Pixar features, found ${movies.length}.`);
}

const resolved = await mapPool(movies, CONCURRENCY, resolveMovie);
const ids = resolved.map(x => x.id);
const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
if (duplicateIds.length) {
  throw new Error(`Duplicate IMDb IDs resolved: ${[...new Set(duplicateIds)].join(", ")}`);
}

// Preserve the curated canon order: Disney in studio release order, then Pixar in studio release order.
const metas = resolved.map(({ _studio, _resolvedName, _resolvedYear, _score, ...meta }) => meta);

const manifest = {
  id: "community.brent.disney-pixar-canon",
  version: "1.0.0",
  name: "Disney + Pixar Canon",
  description: "All released Walt Disney Animation Studios and Pixar feature films in one curated catalog.",
  resources: ["catalog"],
  types: ["movie"],
  catalogs: [
    {
      type: "movie",
      id: CATALOG_ID,
      name: "Disney + Pixar Animated Films"
    }
  ]
};

await writeFile(new URL("./manifest.json", OUT), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(
  new URL(`./catalog/movie/${CATALOG_ID}.json`, OUT),
  JSON.stringify({ metas }, null, 2) + "\n"
);
await writeFile(
  new URL("./resolved-movies.json", OUT),
  JSON.stringify(resolved, null, 2) + "\n"
);
await writeFile(new URL("./.nojekyll", OUT), "");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Disney + Pixar Canon — Stremio Addon</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#eee;max-width:760px;margin:60px auto;padding:0 24px;line-height:1.5}
a.button{display:inline-block;background:#7b5cff;color:#fff;text-decoration:none;padding:12px 18px;border-radius:9px;font-weight:700;margin-right:10px}
code{background:#222;padding:3px 6px;border-radius:5px;overflow-wrap:anywhere}.muted{color:#aaa}
</style>
</head>
<body>
<h1>Disney + Pixar Canon</h1>
<p>95 released feature films: 64 Walt Disney Animation Studios films and 31 Pixar films.</p>
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

console.log(`\nBuilt ${metas.length} movies into dist/.`);
