# 8-Ball (Planck.js)

The planck.js 8-ball example, set up to run in the browser with Vite.

## Run

```sh
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

- Press the cue ball, drag away from it, and release to shoot it the opposite way.
- `npm run build` makes a production build in `dist/`.
- `npm run typecheck` type-checks `8ball.ts`.

## Notes

`8ball.ts` targets Planck.js 1.6's new middleware-based testbed (`planck/testbed`),
which is not published on npm yet (npm's latest is 1.5.1). A matching copy built from
Planck.js `master` (commit `d1e58ef`) is vendored in `vendor/planck`, and
`package.json` installs it as the local `planck` package.

`planck-with-testbed.mjs` is the standalone single-file bundle that was already in
this directory; it is kept for reference but is no longer imported.
