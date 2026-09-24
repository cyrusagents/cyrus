# Miko landing page — Astro + Tailwind

A product landing page grounded in the Miko repository, retaining the typography, monochrome palette, generous spacing, pill controls, rounded cards, and phone demonstration pattern of the original x.ai/bot reconstruction.

## Run

```sh
pnpm --filter @miko/web dev
pnpm --filter @miko/web build
pnpm --filter @miko/web typecheck
```

Open http://127.0.0.1:4321/. The existing `/bot` route renders the same page for compatibility. Astro may run the development server in the background; stop it with `pnpm --filter @miko/web exec astro dev stop`.

## Content and interactions

The hero shows an interactive Slack-style channel preview. The task workflow section uses a Linear-style issue demo inside a phone frame, and the board section displays local screenshots with fictional demo data.

`src/data/use-cases.json` supplies the illustrative tasks. Channel switching, local demo messages, FAQ, task switching, navigation, and theme controls run locally. Setup options link to the documented installer and configuration guides.

## Assets

Current avatars, integration logos, and board screenshots live under `public/assets/`. Official Lucide SVGs and their license are under `src/icons/lucide/`.

Unused images and the icon font from the original x.ai/bot reconstruction have been removed, along with the superseded chat transcript data. The shared `reference.css` stylesheet and typography assets remain in use; `public/assets/manifest.json` records the retained local fonts’ sources.

## Dependency compatibility

Node 22.12+ is required. Narrow root overrides keep Astro and its internal helpers on compatible js-yaml 4.x while the rest of the workspace retains its existing override. No dependencies were changed during the content refactor.
