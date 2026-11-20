# Contributing

Small plugin, small process.

## Getting it running locally

```bash
npm install
npm test                  # vitest, no browser or OpenCode needed
npm run build             # -> dist/gui-experimental.cjs
```

Point your global `~/.config/opencode/opencode.jsonc` at this checkout and give it a
throwaway jobs file if you do not want to touch a real schedule:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-almanac",
      "options": { "repo": "/absolute/path/to/some/project", "jobsFile": ".opencode/almanac/jobs.json" }
    }
  ]
}
```

Then `opencode api post /api/location/reload` for the server part, and **restart the
app** for the GUI part — the desktop app only reloads a bundle when the file changes,
not on a source edit.

## The one rule that matters

**`dist/gui-experimental.cjs` is a committed build artifact.** The desktop app loads
that file directly and a git install cannot run a build. If you change `gui.tsx` or
`rpc.ts` and do not run `npm run build`, your change does nothing and the next person
sees the old behaviour. Rebuild before committing; this is the most likely way to
waste an afternoon.

## Versions

`package.json`, the latest git tag and the install lines in `README.md` must agree.
Bump the package version and tag together in the same release commit, then push the
tag:

```bash
npm pkg set version=x.y.z
git commit -am "…"
git tag -a vx.y.z -m "…"
git push origin main vx.y.z
```

They had drifted once (package `0.1.0`, tag `v0.3.0`), which is why this section
exists.

## Tests

`npm test` runs the scheduler logic and the jobs-file validator. They are pure
functions over dates and files — no OpenCode, no Electron — so most changes can be
tested without running anything.

Worth covering when you touch them: month lengths (28, 29, 30, 31), the clamp on 29–31,
the catch-up window's edges, and a jobs file that fails to parse.

## Pull requests

- One change per PR, with a sentence on *why* — the diff already says what.
- Behaviour changes need a test; the date logic especially.
- If you touch the GUI, say what you saw in the app. The API is experimental and
  "it compiles" is not evidence it renders.
- Do not bump the version in a PR; that happens at release.
