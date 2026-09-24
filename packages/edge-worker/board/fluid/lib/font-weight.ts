// Inter (variable) weight tokens for `fontVariationSettings`.
//
// Each weight is paired with an optical-size (`opsz`) value so that animating
// between weights keeps the text's advance width nearly constant: a heavier
// `wght` widens the text, and a tighter (higher) `opsz` pulls it back.
//
// The compensation is per-glyph, so any residual multiplies with label
// length — calibrate against a CORPUS of realistic strings (4–40 chars,
// mixed/caps/lowercase-heavy at 13px), minimizing the worst-case |delta|
// centered on zero, never against a single baseline string. Measured against
// the 400/opsz-14 baseline: medium and semibold hold every corpus string
// within ±0.4px, bold within ±0.7px. Semibold was re-measured 2026-08-24
// down from opsz 20, which over-corrected and visibly SHRANK long labels
// (−1.6px at 38 chars) on selection.
//
// Setting `opsz` explicitly here overrides `font-optical-sizing: auto`, which
// is intended — we want weight, not font-size, to drive optical size.
export const fontWeights = {
  normal: "'wght' 400, 'opsz' 14",
  medium: "'wght' 450, 'opsz' 15",
  semibold: "'wght' 550, 'opsz' 18",
  bold: "'wght' 700, 'opsz' 25",
} as const;
