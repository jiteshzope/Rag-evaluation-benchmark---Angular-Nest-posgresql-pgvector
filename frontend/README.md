# RAG Evaluation Benchmark — front end

The Angular 21 front end of the benchmark: the four-step setup screen, the live
run view, and the results dashboard. It talks to the NestJS API in
[`../backend`](../backend) and holds no state of its own beyond the current run.

From the repository root:

```
cp frontend/.env.example frontend/.env
npm install                # installs both workspaces
npm run dev:frontend       # http://localhost:5173
npm run build --workspace frontend   # → frontend/dist/
```

`npm run dev` at the root starts the API and the UI together, which is what most
work here needs.

## Configuration

One variable, documented in `.env.example`:

| Variable              | Meaning                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `NG_APP_API_BASE_URL` | Origin of the NestJS backend. Origin only — no trailing slash, no `/api` suffix. |

Angular's builder has no `.env` support of its own, so
`scripts/generate-environment.mjs` bridges the gap: it reads the variable and
writes `src/environments/environment.ts`, which the app imports. The npm `pre*`
hooks run it ahead of `npm start` and `npm run build`, and `postinstall` runs it
after `npm install`, so a fresh clone compiles without a separate step.

The generated file is gitignored — it is output, not source. Edit `.env`, not it.

Precedence is dotenv's: a variable already set in the real environment beats the
`.env` file. That is what makes one codebase work locally, where the value comes
from `.env`, and on Vercel, where it comes from the project settings and there is
no `.env` file at all.

It is read at **build** time — the value is compiled into the bundle, so changing
it on Vercel does not affect a deployment that is already built. Redeploy after
changing it.

Two ways to point it somewhere else:

- **Same-origin deployment** — set `NG_APP_API_BASE_URL=` (empty), which makes
  every request relative.
- **Without rebuilding** — uncomment the `window.__RAGBENCH_API_BASE_URL__` line
  in `src/index.html`. It wins over the compiled-in value, so one built bundle
  can be re-pointed at a staging API.

The dev server runs on **port 5173** rather than Angular's usual 4200 because
that is the origin the backend's CORS allowlist accepts out of the box. If you
change the port, add the new origin to `CORS_ORIGIN` for the API.

## Deploying to Vercel

[`vercel.json`](../vercel.json) at the repository root sets the build command to
`npm run build --workspace frontend` and the output directory to `frontend/dist`,
so point Vercel's Root Directory at the repository root.

Two things to set up:

1. **Add `NG_APP_API_BASE_URL`** under Settings → Environment Variables, applied
   to Production, Preview and Development. Without it the build still succeeds,
   but it warns in the build log and the deployed UI shows its "Cannot reach the
   API" screen, because requests go to the Vercel domain instead.
2. **Add your Vercel URL to the backend's CORS allowlist**, or the deployed UI
   will load and then fail every request. See the
   [backend README](../backend/README.md#two-things-that-cross-origin-changes).

## How it is built

Zoneless throughout. There is no `zone.js` in the build and
`provideZonelessChangeDetection()` is explicit in `app.config.ts`; every piece of
state the UI reads is a signal, so change detection is scheduled by the writes
that cause it. Every component is standalone, `OnPush`, and uses the built-in
control flow (`@if` / `@for` / `@switch`).

That covers what a state library would normally be brought in for:

| Concern                  | Here                                | Why                                                                                        |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Run state                | `ExperimentStore`, a signal service | `applyEvent` is the one reducer over the SSE event stream; every view derives from it.     |
| Server config (`/meta`)  | `MetaStore`                         | The app has exactly one query and one invalidation key, so three signals cover it.         |
| Sorting, filtering, page | `QuestionResultsTable`              | All three are computed signals over the results as they stream in — no table library.      |
| Conditional classes      | `[class.x]` bindings                | Built in.                                                                                  |

### The charts

There is no chart dependency. `BarChart` computes the geometry and emits plain
SVG: grouped columns or sorted rows, a recessive horizontal grid, direct value
labels, and one tooltip design shared by every chart. A `ResizeObserver` handles
resizing. Two details are worth knowing before editing them:

- **Axis ticks.** `niceTicks` does not use the usual 1-2-5 rule: the rough step
  is scaled into `[0.1, 1)`, rounded _up_ to a multiple of 0.05, and scaled back.
  That is what produces steps like 350 and 700 where 1-2-5 would pick 500 and
  1000, and it keeps every numeric axis in the dashboard reading the same way.
- **Bar geometry.** 4px radius on the data end only, 2px between bars in a group,
  22% of each band left empty between groups.

Drawing the charts directly is also why no manual chunking is configured: the
whole app is a 262 kB bundle, 67 kB over the wire.

## Checks

Four suites drive the real UI over the DevTools Protocol. Run them from the
repository root with the API and the dev server both up:

```
node frontend/scripts/ui-flow-check.mjs      # 21 assertions — the setup flow and the demo-corpus lock
node frontend/scripts/ui-upload-check.mjs    # 9  assertions — file upload, CSV parsing, skipped rows
node frontend/scripts/ui-run-check.mjs       # 34 assertions — a live run end to end
node frontend/scripts/ui-cancel-check.mjs    # cancelling a run mid-flight
```

They use headless Edge or Chrome over a plain WebSocket Node opens unaided, so
there is no browser-automation dependency. Set `BROWSER_BIN` to pick a different
binary. Each takes `[appUrl] [screenshotDir] [apiOrigin]` and defaults to the
local pair on `:5173` and `:3001`; screenshots land in
[`../screenshots/`](../screenshots) and fixtures come from
[`../test-fixtures/`](../test-fixtures).

`ui-upload-check` spends 2 uploads of the daily quota and `ui-run-check` spends
one run plus a little API credit; both refuse to start if the budget is short.
