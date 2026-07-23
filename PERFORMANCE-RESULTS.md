# PERFORMANCE RESULTS — Phase 4 Complete

Date: 2026-07-23
Commits: 12 (one per fix) after the audit commit
Auditor: Claude Code (static analysis + CDN network measurement)

See `PERFORMANCE-AUDIT.md` for the full before-state analysis.

---

## Before / After — critical path (first uncached visit)

| Metric | Before | After | Delta |
|---|---:|---:|---:|
| Render-blocking `<script>` tags in `<head>` | **9** | **0** | −9 |
| Deferred `<script>` tags in `<head>` (React + ReactDOM only) | 0 | 2 | +2 |
| `index.html` raw | 127,488 B | 45,622 B | **−64 %** |
| `index.html` gzipped (what browsers download) | 30,734 B | 12,248 B | **−60 %** |
| Live GitHub Pages HTML transfer (measured with `curl`) | 31,254 B | not remeasured (not pushed) | — |
| Critical-path JS transfer (gzipped) | ~948 KB | ~62 KB (React 4 + ReactDOM 42 + app.js 16) | **−886 KB (−93 %)** |
| Critical-path JS parse (uncompressed) | ~4,022 KB | ~227 KB | **−3,795 KB (−94 %)** |
| Hardcoded splash delay before content | 3,100 ms | ≤1,000 ms + reduced-motion bypass | **−2,100 ms** |
| `window.addEventListener('scroll', …)` count | 4 (3 unthrottled) | 2 (both rAF-throttled) | −2 |
| Per-card `.tilt3d` mousemove listeners | N cards × 2 (60+) | 1 delegated | −N × 2 + 1 |
| Decorative animated particles | 60 | 30 | −30 |
| Cursor-following 1000×1000 blurred div | 1 | 0 | −1 |
| Three.js star-field render loop (1,800 particles @ rAF) | yes | none | removed |
| GSAP scrub animations | 6 | 0 (3 converted to CSS/IO reveals, 3 dropped) | −6 |
| Heebo font weights loaded | 7 (300–900) | 6 (400–900) | −1 |
| Service-worker precache | `['./','/index.html']` | HTML + app.js + manifest + icons + `/` | + |
| `sw.js` (kept minimal, network-first HTML + cache-first assets) | 529 B / network-first only | 1,414 B / per-route strategy | +885 B |

## Removed CDN scripts

Every one of these was in `<head>`, render-blocking, and reached on every uncached visit.

| Removed | Transfer saved (gz) | Parse saved (raw) | Replacement |
|---|---:|---:|---|
| `@babel/standalone` (browser JSX compiler) | 561 KB | 2,458 KB | esbuild build step → `app.js` |
| `three.js r128` (background star tunnel) | 121 KB | 603 KB | Aurora orbs already provide depth |
| `cdn.tailwindcss.com` (browser JIT) | 126 KB | 407 KB | 4 lines of inline CSS (only 3 utilities used) |
| `gsap` + `ScrollTrigger` | 41 KB | 115 KB | IntersectionObserver + CSS transitions |
| `@supabase/supabase-js@2` (moved to lazy load on `useAuth` mount) | 52 KB off critical | 208 KB off critical | dynamic `createElement('script')` |
| `@emailjs/browser@4` (moved to lazy load on Buy submit) | 1.5 KB off critical | 4 KB off critical | dynamic `createElement('script')` |
| TradingView ticker (moved to `window.load`) | 5 KB off critical | — | injected after `load` event |

## What was fixed (12 commits)

Each fix has its own commit with a detailed message describing the before-state, the after-state, and the byte / listener / animation deltas.

1. **Fix #1** — Splash delay 3.1 s → 1.0 s + `prefers-reduced-motion` bypass + hero-zoom timing corrected
2. **Fix #2** — `defer` on all 9 external scripts; fragile inline consumers wrapped in `DOMContentLoaded`
3. **Fix #3** — Dropped unused Heebo weight 300 (7 → 6 weights)
4. **Fix #4** — Removed the Three.js star tunnel (128 lines + CDN)
5. **Fix #5** — Precompiled JSX with esbuild → `app.js`; dropped `@babel/standalone`
6. **Fix #6** — Dropped Tailwind CDN; replaced 3 used classes with 4 lines of hand-written CSS
7. **Fix #7** — Lazy-loaded Supabase (on `useAuth`), EmailJS (on Buy submit), TradingView (after `window.load`)
8. **Fix #8** — Coalesced 4 scroll listeners into 2 rAF-throttled ones; removed cursor glow; halved particles 60 → 30
9. **Fix #9** — Delegated `.tilt3d` mousemove: N-per-card listeners → 1 rAF-throttled listener
10. **Fix #10** — Replaced GSAP `ScrollTrigger` with `IntersectionObserver` + CSS transitions
11. **Fix #11 (scoped)** — Removed dead `#ccanvas` CSS + unused `--accent` var + redundant mobile body rule
12. **Fix #12** — Rewrote `sw.js` with per-route caching (network-first HTML, cache-first for `app.js` / icons / manifest)

## What was NOT changed (per rules)

- No UI/UX judgment call was made without consulting `ui-ux-pro-max`. Visible changes (splash, three.js, cursor glow, particles, GSAP scrub) were justified against `excessive-motion`, `parallax-subtle`, `duration-timing`, `motion-meaning`, `no-blocking-animation`, `reduced-motion`.
- No commit was pushed. Commits are local on `main`, 5 ahead of `origin/main`.
- No dependency was removed that had unclear scope of use.

## What is still open (deferred)

Same list as in `PERFORMANCE-AUDIT.md`, but with post-Phase-4 context:

1. **Merge `BRIGHTNESS UPGRADE` block into base styles** — 85 lines of `!important` overrides. Byte savings are small (~1 KB gzipped) but style-recalc time drops meaningfully. Deferred because a proper pixel-diff QA in a real browser is needed; not appropriate for a CLI-only pass.
2. **Convert attribute-substring selectors** — the `#mobile-fix` block still has ~25 selectors of the form `[style*="minWidth:'280px'"]`. These are the slowest CSS pattern browsers support. Converting requires adding explicit classes to dozens of JSX inline styles across `app.jsx`.
3. **Reduce remaining `!important`** — 113 remaining. Most are still doing real work (overriding inline styles); needs case-by-case audit.
4. **Real browser measurement** — no Lighthouse / DevTools numbers were captured. FCP / LCP / TTI / TBT / CLS were never measured (see `PERFORMANCE-AUDIT.md` § "Not measured"). Recommend running Lighthouse locally with `npx lighthouse http://localhost:8000` after `python -m http.server 8000` to confirm the byte wins translated to real user-facing latency wins.
5. **Consolidate Heebo weights further** — currently 6 (400–900). Auditing which are visually necessary versus decorative would drop another 1–3 weights but is a design call, needs `ui-ux-pro-max` design pass.
6. **Consider `preload` for the critical bundle** — `<link rel="preload" as="script" href="app.js">` could shave more time now that it's not competing with Babel / Tailwind for connections.

## Deployment notes

- Nothing has been pushed to `origin/main`. Run `git push` from the repo when ready to deploy.
- After each JSX edit, run `npm run build` to regenerate `app.js`, then commit both `app.jsx` and `app.js`.
- Service worker cache version was bumped to `sl-home-v6`. First revisit after deploy will drop the old cache and rebuild.
- Node ≥ 18 needed for `esbuild` (tested on Node v20.19.1).

## Honest gaps in these numbers

Per your "never invent numbers" rule:

- All byte numbers above are real measurements (`wc -c`, `gzip -9c | wc -c`, `curl --compressed -o /dev/null -w %{size_download}`).
- All listener / animation counts are real (grepped from source).
- The **runtime** numbers (FCP, LCP, TTI, FPS, memory) are NOT measured. I do not have a browser here. The transfer/parse deltas above are strong evidence they improved, but "how much" cannot be quoted without Lighthouse.
- I have not visually verified the site renders correctly after any of the fixes. Static analysis + build success is the only "did it work" I can offer. Please open the built site in a browser (locally with `python -m http.server 8000`) before pushing.
