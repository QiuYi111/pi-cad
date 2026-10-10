Brand sources:
- Application icon: apps/desktop/build/icon.png. Build script only resizes it to ICNS.
- Wordmark / mark paths: apps/desktop/src/renderer/src/components/Brand.tsx.
- Colors, spacing and floating composer: final overrides in desktop styles.css,
  documented in docs/reify-beta-build-2026-09-06.md.
- Geist.ttf: same @fontsource-variable/geist 5.3.0 as desktop package-lock.json.
  Converted geist-latin-wght-normal.woff2 to TTF with fontTools; no glyph changes.
  License: Geist-LICENSE.txt (SIL Open Font License).
Chinese uses the system fallback, matching desktop's font fallback behavior.
Prototype CAD and simulation PNGs are sample outputs, not live project data;
the native viewer displays the actual downloaded model.
