# Web app design system

The rulebook for `apps/web`. Read this before you add or change UI.
The app is one shell with three areas: chat, the run view, and admin.

## Direction

The app reads as a precision instrument. The register is calm, dense,
and flat. The chat thread is a quiet reading column; settings are
cards of label-and-control rows; the chrome, tables, and logs are
flat, bordered, and information-dense.

Rules:

1. **Borders do the work.** Surfaces are flat with 1px borders. Do not
   put shadows on cards. One shadow token (`shadow-overlay`) exists for
   menus, dialogs, and popovers only.
2. **One accent.** Moss blue (`moss`) marks links, focus, selection,
   and the running state. Primary buttons are ink-filled, never blue.
3. **Mono is the spec register.** Set ids, event seqs, scope paths,
   tool args, timestamps, log lines, and policy lines in `font-mono`.
   Uppercase mono labels are banned. Use sentence-case sans labels for
   section headings and other UI labels.
4. **Status is a dot plus a word.** Color carries state information
   only. Do not use status colors as decoration.
5. **Chat is calm.** Agent messages are plain text on the surface — no
   bubble. User messages get a `muted` rounded bubble. The composer is
   the default assistant-ui shape: a rounded shell with the input on
   top and an action row below.
6. **Light and dark ship together.** Never hardcode a color. Use the
   semantic tokens; both themes derive from them. Dark mode is the
   `.dark` class on the root element.
7. **"Surface" is an implementer term.** It never appears in UI copy.
   Users see the concrete pair instead: the connector (Slack, Linear)
   and the location (a channel, a team, a repository). The word lives
   in the specs, the API, and adapter code only.
8. **No em dashes in UI copy.** Rewrite with commas, "such as", or
   separate sentences. Docs and marketing prose keep their own style;
   this rule is for interface chrome.

## Tokens

All tokens live in [src/styles/globals.css](src/styles/globals.css).

- Neutrals: `background` and `card` (one white in light mode — the
  border separates surfaces; dark mode keeps distinct steps), `muted`
  (sunken fill), `border`, `foreground`, `muted-foreground`.
- Action: `primary` (ink fill), `secondary` (quiet fill),
  `destructive`.
- Accent: `moss`, `moss-strong`, `moss-soft`. Use `moss-soft` for
  selected rows, active filter pills, and the selection tint.
- Status pairs: `go`/`go-soft` (success), `wait`/`wait-soft`
  (pending, paused), `destructive`/`destructive-soft` (failed),
  `moss`/`moss-soft` (running). Neutral states use `muted`.
- Type: `text-chrome` (13px UI), `text-meta` (12px descriptions),
  `text-chat` (15px chat prose), `text-log` (12.5px log lines).
- Fonts: Inter (`font-sans`) for UI, JetBrains Mono (`font-mono`) for
  the spec register. Do not add other fonts.
- Radius: `rounded-sm` badges and inputs, `rounded-md` buttons and
  cards, `rounded-lg` dialogs and the composer, `rounded-full` pills.

Caveat: tailwind-merge classifies the custom `text-chrome` and
`text-meta` classes as text colors. When you pass one of them through
`cn()` together with another `text-*` class, the size can get dropped.
In that position, write `text-(length:--text-chrome)` or
`text-(length:--text-meta)` instead. Plain static class strings can
use `text-chrome` and `text-meta` directly.

## Layout patterns

- **App shell.** Collapsible left sidebar (260px): scope switcher on
  top, nav groups, user menu at the bottom. Top bar: breadcrumb entity
  switchers and page tabs. Content scrolls independently.
- **Thread.** Centered 740px column on `card` background.
- **Run view.** 860px timeline column plus a right panel rail; the
  rail collapses into tabs under 1200px.
- **Admin lists.** Filter bar of select pills above a table; row click
  opens the detail route. Empty states get an icon, one line, and one
  action.
- **Settings.** Section label above a white card; the card holds rows
  of "label + one muted sentence | control on the right".

## Component sources

- `src/components/ui/` — vendored shadcn components. Theme through
  tokens; keep upstream APIs so updates stay cheap. Do not hand-roll
  a primitive shadcn already ships.
- `src/components/assistant-ui/` — chat components built on
  `@assistant-ui/react`.
- `src/components/trema/` — product components (badges, approval card,
  timeline pieces, settings grammar, shell). These compose the two
  sets above.

## Verification

- `mise exec -- pnpm --filter @trema/web typecheck` must pass.
- `mise exec -- pnpm exec biome check apps/web` must pass from the
  repo root.
- The `/gallery` route renders every component in every state, in both
  themes. Add new components to the gallery in the same change.
