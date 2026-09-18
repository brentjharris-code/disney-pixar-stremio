# Disney + Pixar Canon — Stremio catalog addon

A single Stremio catalog containing **all currently released Walt Disney Animation Studios and Pixar feature films**.

Current catalog scope (September 18, 2026):

- 64 Walt Disney Animation Studios released features, through **Zootopia 2 (2025)**
- 31 Pixar released features, through **Toy Story 5 (2026)**
- 95 films total
- No DisneyToon/direct-to-video sequels
- No shorts or TV specials
- No live-action remakes
- No films merely distributed by Disney
- **Hexed (November 25, 2026) is intentionally excluded until release**

The source list lives in `movies.mjs`. During deployment, `build.mjs` resolves each title to its IMDb ID using Cinemeta, then generates a completely static Stremio addon in `dist/`.

## Deploy with GitHub Pages

1. Create a new GitHub repository, e.g. `disney-pixar-stremio`.
2. Upload/push everything in this folder to the repository's `main` branch.
3. In GitHub, open **Settings → Pages**.
4. Under **Build and deployment**, set **Source** to **GitHub Actions**.
5. Open the **Actions** tab and wait for **Build and deploy Stremio addon** to finish successfully.
6. Open the GitHub Pages URL shown by the deployment. Click **Install in Stremio**.

You can also paste the manifest URL directly into Stremio's addon search box:

```text
https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPO-NAME/manifest.json
```

## Update the catalog later

Add the new released film to `movies.mjs`, commit/push, and GitHub Actions rebuilds the catalog automatically.

For example, after **Hexed** is released, add:

```js
{ studio: "Disney", title: "Hexed", year: 2026 },
```

Then change the `95` guard in `build.mjs` to `96` (or remove the guard).

## Build locally

Requires Node.js 20+ and internet access:

```bash
npm run build
```

Then serve `dist/` from any HTTPS static host. Stremio requires the addon endpoints to be accessible over HTTP(S) with CORS; the Stremio protocol documentation specifically supports static addons.

## Generated endpoints

```text
/manifest.json
/catalog/movie/disney-pixar.json
```

The addon provides **catalog only**. Movie detail metadata continues to resolve through the IMDb IDs, and your existing stream addons (including AIOStreams) continue handling playback sources.
