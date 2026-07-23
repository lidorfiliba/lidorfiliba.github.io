# PERFORMANCE AUDIT — lidorfiliba.github.io (StockLens Academy)

Date of audit: 2026-07-23
Repo commit audited: `549bbce`
Auditor: Claude Code (static analysis + CDN network measurement, no browser profiling — see "Not measured" below)

---

## TL;DR

The site is a single 125 KB HTML file (`index.html`) that pulls **~948 KB of gzipped JavaScript from 9 different CDNs**, all render-blocking in `<head>`. The browser then has to **parse ~4 MB of uncompressed JS**, of which **2.4 MB is Babel** — a full JSX compiler that runs on every page load because there is no build step. After all that, a **splash screen forces a hardcoded 3.1-second delay** before any content is shown. On top of that, the page runs a Three.js star tunnel, 60 animated particles, a mouse-following cursor glow, GSAP ScrollTrigger, and 4 separate scroll listeners simultaneously.

Two changes alone (kill Babel-in-browser, remove the 3.1s splash delay) will remove roughly **2.5 MB of parse work and 3+ seconds of forced wait** without changing what the site looks like.

---

## Project map (Phase 1)

| Property | Value |
|---|---|
| Type | Static site hosted on GitHub Pages |
| Framework | None (React 18 UMD loaded via CDN) |
| Build tool | **None** — JSX is compiled in the browser at runtime by `@babel/standalone` |
| Package manager | None (no `package.json`, no lockfile) |
| Entry point | `index.html` (one file, 2,298 lines) |
| Other files | `sw.js` (24 lines), `manifest.json`, `icon-192.png`, `icon-512.png` |
| How to run locally | `python -m http.server 8000` (or any static server) — no `npm install`, no dev server |
| CI/CD | GitHub Pages auto-deploys `main` branch |

No dev scripts to run, no bundler config, no tsconfig. Everything lives in `index.html`.

---

## Measured numbers (Phase 2)

All numbers below are real measurements, not estimates. Method noted per row.

### Files in the repo

| File | Bytes | Notes |
|---|---:|---|
| `index.html` | 127,488 | 2,298 lines |
| `index.html` gzipped | 30,734 | what browsers actually download |
| `index.html` brotli q11 | 25,922 | if GitHub Pages served br (it doesn't) |
| `icon-512.png` | 37,516 | |
| `icon-192.png` | 11,795 | |
| `sw.js` | 529 | |
| `manifest.json` | 582 | |

### Live GitHub Pages response for `/`

Measured with `curl --compressed https://lidorfiliba.github.io/`:

| Metric | Value |
|---|---|
| HTTP status | 200 |
| Content-Encoding | gzip |
| Transfer size (HTML only) | **31,254 B** |
| Time to full HTML | 221 ms (single request, my network) |
| Cache-Control | `max-age=600` (10 minutes) |

The HTML itself is fine. The problem is what it loads.

### Render-blocking external scripts (in `<head>`, no `async`/`defer`)

All 9 scripts below are measured with `curl --compressed`. Transfer = what your browser downloads. Uncompressed = what the JS engine parses and keeps in memory.

| # | Source | Line in index.html | Transfer | Uncompressed | Note |
|---|---|---:|---:|---:|---|
| 1 | `cdn.tailwindcss.com` | 14 | **126 KB** | 407 KB | This is the *browser JIT* Tailwind build. Explicitly not for production. |
| 2 | `@supabase/supabase-js@2` | 18 | 52 KB | 208 KB | Only used by login modal (not on first paint) |
| 3 | `react@18/umd` | 19 | 4 KB | 11 KB | |
| 4 | `react-dom@18/umd` | 20 | 42 KB | 132 KB | |
| 5 | **`@babel/standalone`** | 21 | **561 KB** | **2,458 KB** | Full Babel compiler. Needed only because JSX is not pre-compiled. |
| 6 | `@emailjs/browser@4` | 203 | 1.5 KB | 4 KB | Used only by contact form |
| 7 | `gsap 3.12.5` | 206 | 25 KB | 72 KB | |
| 8 | `gsap ScrollTrigger` | 207 | 16 KB | 43 KB | |
| 9 | `three.js r128` | 208 | **121 KB** | **603 KB** | Only used for the background star field |
| | **Total blocking JS** | | **~948 KB** | **~4,022 KB** | |

**HTML + blocking JS = ~980 KB transfer / ~4.15 MB parsed on every uncached visit.**

Plus:
- Heebo Google Font loaded at **7 weights** (300, 400, 500, 600, 700, 800, 900) — confirmed by grepping `@font-face` count in the CSS response. Two weights are typical; seven is excessive.
- `s3.tradingview.com/external-embedding/embed-widget-ticker-tape.js` (5 KB) which then loads its own iframe with more scripts.

### DOM/CSS statistics (grepped in `index.html`)

| Metric | Count |
|---|---:|
| `!important` declarations | **114** |
| Uses of `backdrop-filter` / `filter: blur` / `will-change` / `mix-blend-mode` | 26 |
| React hooks / component declarations | 142 |
| `<style>` blocks in `<head>` | 6 (all inline, duplicated concerns) |
| Attribute-substring CSS selectors like `[style*="minWidth:'280px'"]` | 25+ occurrences in the `#mobile-fix` block (lines 448–537) — these are among the slowest selectors browsers support |

### Scroll / mouse listeners on `window`

Confirmed by grep of `addEventListener`:

| # | Where | Line | Throttled? |
|---|---|---:|---|
| 1 | Navbar scrolled state | 1687 | No (cheap, just sets React state) |
| 2 | Parallax orbs | 1801 | rAF (good) |
| 3 | Cinematic progress bar | 1908 | No |
| 4 | Cinematic vignette (per-scroll `setTimeout`) | 1924 | No |
| 5 | Letterbox flash | 1994 | No |
| 6 | Three.js scroll % | 2104 | Cheap (assignment only) |
| 7 | Three.js resize | 2134 | No |
| 8 | `mousemove` for cursor glow (fires on every pixel) | 1746 | No |
| 9 | `mousemove` for card 3D tilt (added to every `.tilt3d`) | 1828 | No |

### Deferred timers ("time to actually usable")

Hardcoded delays that keep the JS main thread busy after render:

| Delay | What starts | Line |
|---:|---|---:|
| 950 ms | Parallax reveal + auto-tag every element with `data-reveal` | 1880 |
| 1,700 ms | GSAP ScrollTrigger init | 2288 |
| 1,800 ms | Colour temperature overlay init | 1962 |
| 2,200 ms | Letterbox init | 1991 |
| 2,800 ms | 3D tilt attachment | 1881 |
| **3,100 ms** | **Splash screen dismiss (main content hidden until then)** | **880** |
| 5,200 ms | ScrollTrigger refresh | 2290 |
| 3,800 ms | `setInterval(spawnStar)` — forever | 1790 |

### Continuous work while the tab is open

- Three.js render loop: `requestAnimationFrame(renderLoop)` — 1,800 particles rendered every frame even when the user is idle (line 2112).
- 60 CSS-animated particles with box-shadow, each a compositing layer (line 1761).
- `setInterval(spawnStar, 3800)` — forever spawning + removing DOM nodes (line 1790).
- 5 large radial-gradient orbs with `filter: blur(65–90px)` continuously animated (lines 214–252).
- Cursor-glow div (1000×1000px, `mix-blend-mode: screen`, `filter: blur(6px)`) repositioned on every mousemove (line 1746).

### Not measured (I don't have a browser here)

Per your rule — no invented numbers. The following require a real browser (Lighthouse / WebPageTest / Chrome DevTools) and I did **not** run one:

- First Contentful Paint (FCP)
- Largest Contentful Paint (LCP)
- Time To Interactive (TTI)
- Total Blocking Time (TBT)
- Cumulative Layout Shift (CLS)
- Actual scroll FPS on a real device
- Real device memory / thermal impact
- Whether the site currently throws runtime errors in a real browser
- Actual per-visit repeat performance (service-worker cache warmth)

If you want these numbers, I can either walk you through running Lighthouse locally, or if you have a way to run Chrome headless from CLI I can wire up a measurement.

---

## Issues, sorted by impact × effort

Impact = end-user latency + main-thread work removed. Effort = a rough guess of how long the fix takes. Sort is roughly best ROI first.

| # | Issue | Impact | Effort | Est. wins |
|--:|---|---|---|---|
| 1 | Splash screen forces 3.1s hardcoded delay before ANY content shows | **Huge** | Trivial | -3.1s TTI |
| 2 | `@babel/standalone` compiles JSX in the browser on every load | **Huge** | Medium | -561 KB transfer, -2.4 MB parse, seconds of CPU |
| 3 | Tailwind CDN JIT compiles CSS in the browser on every load | **Huge** | Medium | -126 KB transfer, -407 KB parse |
| 4 | Heebo font loaded in 7 weights | High | Trivial | ~-100 KB fonts |
| 5 | Three.js star tunnel (1,800 particles rAF loop, decorative) | High | Trivial | -121 KB transfer, -603 KB parse, continuous GPU/CPU |
| 6 | All external scripts render-blocking (no `async`/`defer`, no `preconnect` beyond fonts) | High | Trivial | Parallel download, faster FCP |
| 7 | GSAP + ScrollTrigger for effects that CSS/IntersectionObserver can do | High | Medium | -40 KB transfer, less main-thread work |
| 8 | Auto-attach `.tilt3d` mousemove listener to **every** grid child | High | Low | Cuts hundreds of listeners + layout thrash |
| 9 | 60 animated particles + shooting stars `setInterval` + cursor glow (all decorative, all GPU) | High | Low | Big paint/composite win, esp. on laptops |
| 10 | 4 separate scroll listeners (progress bar, vignette, letterbox, Three.js scroll) not coalesced | Medium | Low | Fewer forced re-layouts on scroll |
| 11 | 114 `!important` and a full "BRIGHTNESS UPGRADE" style block that overrides earlier CSS | Medium | Medium | Smaller CSS, faster style resolution |
| 12 | `[style*="minWidth:'280px'"]` attribute selectors in `#mobile-fix` — slowest CSS selectors | Medium | Low | Faster style recalc on every DOM change |
| 13 | Service worker only caches `./` and `/index.html`; the 948 KB of CDN JS is refetched every visit | Medium | Low | Repeat-visit speed |
| 14 | Supabase JS (52 KB) loaded on first paint but only used when user clicks "Buy" | Medium | Low | -52 KB from critical path |
| 15 | EmailJS (1.5 KB but blocking) loaded on first paint but only used by contact form | Low | Trivial | -1 blocking script |
| 16 | TradingView ticker widget loads before user scrolls to it | Low | Trivial | Fewer network requests on first paint |
| 17 | Exposed Supabase `SUPA_KEY` in HTML (line 741). *Not a perf issue* — flagging anyway. If this is a real anon key, it's fine (anon keys are meant to be public), but confirm it isn't a service_role key. | — | — | Security note only |

---

## Detailed findings

### #1 — Splash screen hard-blocks the site for 3.1 seconds

**File:** `index.html:875–932` (component), invoked at `1707`, timer at `879–881`.

```js
// index.html:879–881
const t1 = setTimeout(() => setPhase(1), 2300);
const t2 = setTimeout(onDone, 3100);
```

The `<SplashScreen>` overlay is rendered by React on top of `<main>` and does not disappear until 3.1 seconds have passed. This time is fixed regardless of how fast the site is. The animation itself lasts ~880 ms.

**Fix (proposed):** Either remove the splash entirely, or drive its dismissal by a real event (`window.load`, or the first paint of the hero). If you want to keep the cinematic entrance, cap the wait at ~1.2 s and let real-loaded-state cut it short.

---

### #2 — `@babel/standalone` runs a full JSX compiler in the browser

**File:** `index.html:21` (script tag), `index.html:736` (`<script type="text/babel">`).

```html
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
...
<script type="text/babel">
  const {useState,useEffect,useRef}=React;
  ...
```

Babel-standalone is 561 KB gzipped / **2.4 MB uncompressed**. On every uncached visit the browser downloads it, parses it, then runs it over the ~1,000-line JSX block inline in your HTML. That's the single biggest cost on this page.

Babel's own docs say: *"In-browser transformation is generally not recommended for production use. You should use precompiled code instead."*

**Fix (proposed):** Precompile the JSX once, ship plain JS. Minimum-friction options:

- **A. Local one-shot build.** Add a `package.json` with `esbuild` (single-file, zero-config). Command: `esbuild app.jsx --bundle --minify --format=iife --outfile=app.js`. Extract the `<script type="text/babel">` block into `app.jsx`, replace the two script tags with `<script src="app.js" defer>`, commit `app.js`.
- **B. Migrate to Vite** (adds real dev experience later; more setup).

Option A is the smallest change and keeps the repo static-only. My recommendation: do A now, B later.

---

### #3 — Tailwind CDN runtime compiler

**File:** `index.html:14`.

```html
<script src="https://cdn.tailwindcss.com"></script>
```

This is Tailwind Play CDN — a Tailwind JIT compiler that runs in the browser and generates CSS at runtime from your class names. 126 KB gzipped / 407 KB uncompressed. Tailwind explicitly labels this **"for development only"**.

**Fix (proposed):** Same build step from #2. Add `tailwindcss` as a dev dep, run `tailwindcss -i input.css -o dist.css --minify` once. Replace the CDN tag with `<link rel="stylesheet" href="dist.css">`. Typical output for a site this size: 8–20 KB gzipped, versus 126 KB now.

---

### #4 — Heebo font loaded in 7 weights

**File:** `index.html:17`.

```html
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
```

Confirmed: the CSS response contains 7 `@font-face` rules, each linking to a separate file. Hebrew glyph coverage adds weight per file.

**Fix (proposed):** Grep the codebase for actually-used `fontWeight` values. From what I saw skimming: 400, 700, 900 are common; 300/500/600/800 look decorative. Reduce to 3 weights max (e.g. 400, 700, 900). Additionally add `&text=…` or subset to Hebrew+Latin only.

---

### #5 — Three.js star tunnel

**File:** `index.html:208` (script tag), `index.html:2018–2140` (init + render loop).

Loads 121 KB gzipped / 603 KB uncompressed of `three.min.js` to draw 1,800 star particles behind the content. Runs `requestAnimationFrame` continuously.

The star field is disabled on mobile (`if (!MOBILE)` at line 2018) and disabled for reduced-motion (`if (REDUCED) return;` at line 1898). On desktop it runs forever.

**Fix (proposed):**
- Simplest: delete this section entirely. The 5 CSS orbs already give the "space" feel.
- Middle ground: replace with a `<canvas>` and ~200 lines of vanilla 2D canvas code that draws 400 dots — no library. Saves ~600 KB of parse + a lot of GPU.
- Also possible: keep Three.js, but load it dynamically only after `window.load` fires. Doesn't help TTI but stops blocking first paint.

---

### #6 — All external scripts render-blocking

**File:** `index.html:14, 18, 19, 20, 21, 203, 206, 207, 208`.

None of the CDN `<script>` tags have `async` or `defer`. The browser must download, parse, and execute each in order before rendering the body.

**Fix (proposed):** Once #2 is done (JSX precompiled), the app-init script becomes `defer`-safe. UMD React, Supabase, GSAP, EmailJS, and Three.js all work fine with `defer`. Add `defer` to every remaining external `<script>` in `<head>`. Order-preserving, parallel download.

---

### #7 — GSAP + ScrollTrigger for effects CSS/IO can do

**File:** `index.html:206–207` (scripts), `index.html:2147–2285` (usage).

The GSAP animations in this file are: hero pull-back on scroll, aurora blob parallax, h2 heading parallax, stats grid scale-in, pricing card blur-in, CTA banner zoom-in. Every one of these is a scrub-based scroll animation.

**Fix (proposed):** Replace with either:
- CSS `animation-timeline: view()` / `animation-timeline: scroll()` (broad browser support in 2026), or
- A single `IntersectionObserver` that toggles CSS classes.

Removes 40 KB of transfer and ~115 KB of parse, plus removes GSAP's own render loop.

---

### #8 — `.tilt3d` attached to every grid child

**File:** `index.html:1859–1867`.

```js
document.querySelectorAll('[style*="grid"]').forEach(grid => {
  Array.from(grid.children).forEach((card, ci) => {
    ...
    card.classList.add('tilt3d');
  });
});
```

Then `initTilt()` adds a `mousemove` listener to every `.tilt3d`. On this page that's every card in every grid — dozens of listeners each writing `transform` and `boxShadow` on `mousemove`, which forces style + layout recalc per pixel.

**Fix (proposed):** Attach one listener to the grid container and use event delegation, only computing tilt for the card actually under the cursor. Or drop tilt entirely on mobile / reduced-motion / large card counts. Or apply tilt only to `.pricing-card` and hero card.

---

### #9 — Decorative overlays: 60 particles + shooting stars + cursor glow

**File:** particles `index.html:1751–1776`, shooting stars `1778–1790`, cursor glow `269–278` (CSS) + `1745–1749` (JS).

60 absolutely-positioned divs with individual `box-shadow: 0 0 Xpx color, 0 0 2Xpx color`, all running `animation: particleFloat` infinite. Each is a compositing layer.
Shooting stars: `setInterval(spawnStar, 3800)` runs forever, creating a DOM node with box-shadow + animation, then removing it 1.1s later.
Cursor glow: a 1000×1000 fixed div with `mix-blend-mode: screen` + `filter: blur(6px)` repositioned on every mouse move.

**Fix (proposed):** Cut the particle count in half (30 is still visually dense). Drop the cursor glow entirely — it's a laptop battery killer and near-invisible. Replace the shooting stars `setInterval` with a CSS-only animation on 2–3 static SVG lines.

---

### #10 — Four separate scroll listeners

**File:** `index.html:1687, 1801, 1908, 1924, 1994, 2104`.

Six listeners, three throttled (line 1801 uses rAF, lines 1687 and 2104 are cheap), three unthrottled. Every scroll event reads `window.scrollY` multiple times and writes styles.

**Fix (proposed):** One shared scroll handler behind a single `requestAnimationFrame` throttle that dispatches to all subscribers. Or fold the cinematic engine into the parallax engine that already has rAF throttling.

---

### #11 — 114 `!important` + overriding "BRIGHTNESS UPGRADE" style block

**File:** `index.html:118–200` (the `BRIGHTNESS UPGRADE` block).

The main style block sets up variables and component styles, then the next 80 lines override large portions of that with `!important`. Symptoms:

- Two `@keyframes glow` and two `@keyframes aurora` definitions (second overrides first).
- Two `--green` values (`#00E5A0` then `#00FFB3` at line 126) — the design system is inconsistent.
- Buttons, cards, borders all restyled twice.

**Fix (proposed):** Merge the BRIGHTNESS UPGRADE values back into the base styles, delete the `!important`. Not a huge byte saving, but simpler CSS = faster style resolution and easier future maintenance. Any visual change here **must go through ui-ux-pro-max** per your rule.

---

### #12 — Attribute-substring selectors

**File:** `index.html:448–537` (block `#mobile-fix`).

Examples:

```css
[style*="minWidth:'280px'"], [style*="minWidth:'340px'"], ... { min-width: 0 !important; }
[style*="gridTemplateColumns:'repeat(2"], ... { grid-template-columns: 1fr !important; }
[style*="padding:'40px 36px'"] { padding: 24px 18px !important; }
```

These read the full inline `style` attribute of every element in the document and substring-match on every restyle. This is the slowest supported form of selector.

**Fix (proposed):** Convert the inline styles they target into class names (`.card-lg`, `.grid-3`, etc.) and select on those. Same visual outcome, orders of magnitude faster.

---

### #13 — Service worker doesn't cache the actual heavy stuff

**File:** `sw.js:1–24`.

```js
const CACHE='sl-home-v5';
const ASSETS=['./','/index.html'];
```

The service worker only precaches HTML and the root. All CDN scripts, fonts, and images are refetched from the network on every visit (unless the browser's HTTP cache still has them).

**Fix (proposed):** After #2/#3 land, precache the self-hosted `app.js`, `dist.css`, and fonts. Do **not** precache the CDN URLs directly — cross-origin caching is fragile.

---

### #14 — Supabase loaded before it's needed

**File:** `index.html:18` (blocking load), `index.html:742` (client init), `index.html:747–756` (session check on mount).

The Supabase client is initialized at module top-level, meaning it fires an auth `getSession()` immediately on first paint. The client is only used when the user opens the Purchase modal.

**Fix (proposed):** Dynamic `import()` on Buy button click. Or a `<script>` tag inserted at that moment. Saves 52 KB on the critical path and skips the auth network call for visitors who never click Buy.

---

### #15 & #16 — EmailJS + TradingView ticker loaded eagerly

**File:** EmailJS `index.html:203–204`, TradingView `index.html:715`.

EmailJS is used only in the (future?) contact form. TradingView ticker is decorative and can lazy-load when the top bar becomes visible or after `window.load`.

**Fix (proposed):** Move both behind an `IntersectionObserver` or defer with `<script defer>`.

---

### #17 — Supabase key exposure (not a perf issue)

**File:** `index.html:741`.

```js
const SUPA_KEY='eyJhbGci...';
```

This looks like an anon key (safe to expose by design). But the value truncates with `Yw1234placeholder`, which suggests it may be a fake / placeholder key and auth doesn't actually work. Worth confirming.

---

## Suggested fix order (Phase 4 preview, blocked pending your approval)

1. Remove hardcoded splash delay (#1) — 5-minute change, biggest visible win.
2. Add `defer` to all `<script>` tags (#6) — 10 minutes, zero risk.
3. Reduce Heebo weights (#4) — 2 minutes.
4. Delete Three.js star tunnel or replace with vanilla canvas (#5) — 30 minutes.
5. Precompile JSX with esbuild, drop `@babel/standalone` (#2) — 1–2 hours, biggest measured byte win.
6. Precompile Tailwind, drop CDN (#3) — 1 hour.
7. Lazy-load Supabase / EmailJS / TradingView (#14–#16) — 30 minutes.
8. Coalesce scroll listeners + drop cursor glow / cut particles in half (#9, #10) — 1 hour.
9. Replace `.tilt3d` per-card mousemove with delegated handler (#8) — 30 minutes.
10. Replace GSAP scrub with CSS/IO (#7) — 2–4 hours.
11. Clean up `!important` + attribute selectors + BRIGHTNESS UPGRADE (#11, #12) — 1–2 hours, needs UI review through ui-ux-pro-max.
12. Fix service worker precache (#13) — 30 minutes.

Any change that touches visible pixels (colors, spacing, animations, layout) must go through ui-ux-pro-max per your rules.

---

## STOP

Per Phase 3 of your brief: **not making any changes until you approve this audit**.

Reply with what to fix (all / by number / different order), and I'll do them one at a time, remeasuring after each, with a separate commit per fix.
