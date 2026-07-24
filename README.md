# Splat Hike

A walking simulator for 3D Gaussian Splat scenes. Pure static site — HTML/CSS/JS
with ES module imports (PlayCanvas engine loaded from jsdelivr's CDN at
runtime), no build step, no bundler, no backend.

## Run it locally

```bash
npx http-server hiking-splat-sim -p 8080 -c-1
```

Then open http://localhost:8080. Any static file server works the same way
(Python's `http.server`, VS Code's Live Server, etc.) — the only requirement
is serving over `http://`/`https://`, not `file://`, since ES modules and
`fetch()` need a real origin.

## Deploy for free

**Cloudflare Pages** (recommended): `wrangler pages deploy hiking-splat-sim`
(or drag-and-drop the folder at pages.cloudflare.com) — no config needed,
it's just static files.

**Cloudflare Workers** (static assets): put this folder behind a Worker with
an `assets` binding in `wrangler.jsonc` and no `main` script if you don't
need any server logic.

**Anything else that serves static files** works too (Netlify, GitHub Pages,
Vercel, S3+CloudFront, your own nginx). There's nothing here that needs a
Node server at runtime — `http-server` above is only for local testing.

## How scene loading works

Scenes come from two places:

- **superspl.at share links** (`https://superspl.at/scene/<hash>`) — resolved
  client-side to the public CDN asset the official viewer itself uses (see
  `src/core/scene-loader.js` for the mechanism, adapted from
  [Rouf0x/splatfpv](https://github.com/Rouf0x/splatfpv), MIT license).
- **Direct splat file URLs** or **local files** (`.ply`, `.compressed.ply`,
  `.sog`, `.meta.json`) — loaded straight into the PlayCanvas `gsplat`
  component.

Add your own via the "+ Add scene" button — pasted scenes are saved in this
browser's `localStorage`, nothing is uploaded anywhere.

## Collision & walking

Two collision strategies, picked automatically per scene:

- **Voxel collider** (real collision): built client-side from the splat's
  point centers when they're available (most `.ply`/`.compressed.ply` and
  chunked `.meta.json` scenes). Cells need a minimum splat density to count
  as solid, which filters out the stray outlier points that photogrammetry
  reconstructions reliably produce around water/reflective surfaces.
- **Flat-plane fallback**: used for streamed `.lod-meta.json` scenes, whose
  points live in a GPU-only streaming buffer with no CPU-side array to
  voxelize. Ground height is estimated from the octree's chunk bounds
  instead (a robust low-percentile across chunks, not the raw minimum, for
  the same outlier reasons as above).

Either way you get gravity, ground-snapping on slopes, step-up onto small
ledges, and axis-separated sliding collision against real obstacles — not a
flat glide-over-everything hover.

## Known limitations

- Community scans have wildly inconsistent real-world scale (some are in
  plausible meters, some are 10-100x too large/small) — there's no reliable
  way to auto-detect this, so walk speed/gravity can feel off per scene.
  Nudge "Walk speed" in Settings if a scene feels like moonwalking or a
  100m dash.
- The flat-plane fallback (streamed scenes) means no per-obstacle collision
  there, just a walkable floor at an estimated height.
- Auto-advance (walking to the edge of a scan) uses bounding-box proximity
  and splat-density thinning as proxies — it's a heuristic, not a precise
  "end of scan" detector.
