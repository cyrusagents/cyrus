# Fluid Functionalism components

These are the official MIT-licensed registry components from
https://www.fluidfunctionalism.com/docs, retrieved on 2026-09-23.
`registry.json` records each source URL and the SHA-256 of the original response.

The board uses Button, Badge, InputGroup, Select, Switch, Tabs and Dialog plus their
registry dependencies. Component source is retained with import aliases remapped to
relative imports; `lib/utils.ts` supplies the standard clsx/tailwind-merge helper.
`registry.css` contains the registry's tokens and CSS additions. Global focus rules
are scoped to `.fluid-scope`; the site's shape-switching transition override is omitted.
`theme.css` adds the board's neutral theme and locally bundled Inter variable font.

The existing esbuild board build compiles Tailwind utilities through PostCSS. There
is no global Tailwind preflight: the reset and color tokens stay inside Fluid surfaces.
CSS layers are flattened to coexist with the older unlayered log-viewer stylesheet.
Components and the font are bundled locally; the browser makes no CDN requests.
The Fluid MIT license and Inter OFL license are included in the generated license bundle.

Upstream source is excluded from project-specific formatting/lint rewrites. For an
upgrade, fetch the recorded registry URLs and their dependencies, review the source
diff, remap imports, and regenerate registry CSS. Test dialogs, selects, keyboard focus,
reduced motion, schedule previews and form serialization before shipping.
