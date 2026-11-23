# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ryukaa853/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ryukaa853/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0, make.fun's own static site generator, built for make.fun's "Build a static site faster, 22 November 2026" bounty ($100 in USDC, top 10 at $10 each). It answers exactly as makefun-site 1.0.0 does on every case — the same output tree, byte for byte: every page's `index.html`, the index and tag pages, `build-report.txt` and each static file.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`), answers each one alone with `run()` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`). It runs on Node 22.18 or later, with nothing to install: `solve.js` is a dependency-free ES module and `main.ts` needs only `node:fs`, `node:path` and `node:v8`.

## What it does

`run(input)` takes one case's `{ site, templates, files }` — 200 to 600 Markdown sources, a few static files and 14 to 30 templates — and returns the output tree makefun-site 1.0.0's `build` returns for it: a JSON object of every path the build writes and that file's text. makefun-site's front matter, template dialect, Markdown subset, slug rule and build report are its own (not Hugo's, Zola's, Eleventy's or CommonMark's), and this implementation follows them exactly, including the refusal and draft reports, the broken-link reports, slug collisions, non-ASCII titles, and the template parse errors.

## How it is faster

The reference walks Markdown inline text one character at a time (escaping each character with its own replace), re-slugifies the same tag names over and over, rebuilds every post's card for its page, and re-renders the same header and footer for every page through a tree-walking template interpreter. This entry instead:

- renders Markdown inline text with a single regex scan for markup characters, escaping the plain runs between them in one replace each, and skips the escape copy entirely for runs that hold nothing to escape;
- memoises slugs per build and counts a body's words by hand instead of building a throwaway array of every word;
- parses front matter without splitting the whole source (the Markdown pass splits the body again), and only normalises line endings when a `\r` is actually present;
- compiles every template once per build into a small function — variable lookups become direct scope reads, loops save and restore scope by assignment (never `delete`, so the scope object keeps its fast shape) — and caches the renders that only read the site-wide values (`site`, `tags`, `recent`), such as the header and footer, so they are rendered once per case instead of once per page;
- builds each post's card once and shares it between its page, the index and the tag pages, and reuses the Markdown table-of-contents entries and tag objects instead of copying them.

No clock, no randomness, no network, no model calls, no state kept from one case to the next; the same input always gives the same answer.

## Measured speed

On the kit's practice set (3 cases, 1,135 Markdown sources), whole-program CPU time on this machine (Node v22.23.5, one CPU), median of 7 runs each:

| program | CPU, median of 7 runs |
|---|---|
| makefun-site 1.0.0 (house baseline) | 1,798 ms |
| site-generator-speed (this entry) | 983 ms |

All 3 practice cases byte-identical to makefun-site's expected answers, and 15 further cases drawn from the competition's own generator also byte-identical. Two runs of the entry on the practice set produce byte-identical `answers.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8tc4hwe6&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
