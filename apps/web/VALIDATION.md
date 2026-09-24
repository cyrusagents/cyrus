# Validation — preserve the original UI

## Independent PR verification — 2026-09-24

- Reassembled the final website on a clean `origin/main` worktree, without the
  unrelated automation and Cursor changes or the superseded `apps/grok-bot` tree.
- Full build and workspace typecheck passed. Final Astro check covered 20 files
  with zero errors, warnings or hints; both `/` and `/bot` built successfully.
- Verified every local `src` and `href` in both production HTML pages resolves.
- Full package suite: 2,021 passing tests, two skipped.
- Frozen-lockfile install and official npm-registry audit passed with no advisories.
- Full lint passed with 47 warnings, including existing workspace warnings and
  Astro template variables/imports that Biome does not recognize as used. Astro's
  own checker passes; no unsafe unused-variable fixes were applied to templates.
- Formatted owned source and manifests. The retained third-party `reference.css`
  is excluded from formatting/lint rewrites to preserve its original rendering.
- New browser inspection was rejected by the browser approval layer; the earlier
  desktop/mobile interaction checks below remain the visual evidence. No fresh
  browser verification is claimed for this PR-preparation pass.

## Earlier visual verification

- Restored the committed original component structure and illustrations.
- `src/styles/global.css` and `src/pages/index.astro` exactly match `e5c837e4`.
- Replaced product copy, links, and demo transcript content inside the existing visual shell.
- Browser verified the original desktop hero and phone layout, including Feature Work selection and its transcript.
- Production build passes for `/` and `/bot`.
- Astro check: 18 files, zero errors/warnings/hints.
- Biome passes for interaction code and data.
- F1 investigation smoke from the content refactor remains documented separately; runtime code did not change in this UI correction.

## Platform visibility update

- Added a dedicated integration section with local Linear, GitHub, Slack, Claude Code, Codex and Cursor icons, plus GitLab/Zulip/Gemini/OpenCode documentation links.
- Hero now names the actual task platforms and coding agents, with a compact platform icon row.
- Verified all six section images loaded. At 390px the icons form three columns and document width remains 390px.
- Existing global stylesheet remains unchanged; new section styles are scoped.

## Linear issue demo update

- Replaced the task section’s chat phone with a scoped Linear-style issue detail component.
- Eight workflow buttons select structured issue examples; native details expand earlier activity entries.
- Browser verified Bug Fixes, Feature Work selection, activity expansion, scrolling, and the agent response card.
- Astro production build passes for both routes; Astro check reports zero errors, warnings, or hints.
- Comment and toolbar artwork are decorative; this demo does not connect to Linear.

- Restored the original 300×650 phone frame, side buttons, 48px top inset and black camera capsule; removed simulated time/battery UI. Replaced placeholder glyphs with SVG icons for Linear controls, project, calendar, PR, reaction and delegation.

- Activity is newest first: final response, two collapsible earlier activities, then issue creation. Removed duplicate response/assignment events, internal workspace events, and unsupported completion claims.

## Slack hero demo

- Replaced the hero chat mockup with a Slack-style workspace, channel sidebar, message timeline, mentions, reactions, and composer.
- Browser verified channel switching and sending a local-only preview message.
- At 390px, document width remains 390px and all three channels remain accessible through compact channel navigation.
- Removed obsolete hero chat handlers; the Linear task demo remains independent.

- Slack demo controls now use official Lucide 1.47.0 SVG assets with their license retained. Browser verified all control SVGs use Lucide and the GitHub brand image is unchanged. Outer/inner radii are 12px/6px with a 5px inset plus 1px outer border; sidebar/message seam stays square. Astro build and typecheck pass.
