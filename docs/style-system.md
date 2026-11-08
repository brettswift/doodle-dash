# Crayon Breath style system

The game is branded Crayon Breath. The repo, Fly app, storage keys and other internal identifiers still say doodle-dash; only visible text changed. The look comes from the approved paper-and-crayon mock-up (`~/ephemeral_websites/crayon-breath/paper-and-crayon.html` on buddyserver). Everything lives in `public/style.css`; there are no frameworks, CDNs or external requests.

## Fonts

Both fonts are SIL OFL, self-hosted in `public/fonts/` and served by the static file map in `server.js` (`FILES`). A new font file must be added there too, or it will 404.

- Schoolbell (`--kid`): the title, card headings, big numbers and the hint word. Kid handwriting.
- Patrick Hand (`--hand`): body text, buttons, inputs, the timer and scores. Its digits read clearly; Schoolbell's "1" looks like "I", so never use it for countdowns.

## Colours

- Light values below; dark values are in the `:root[data-theme=dark]` block (see Themes).
- Paper `--paper` #f7f0df with a faint 7px dot texture on `body`; card fill `--sheet` #fffbef; ink `--ink` #2d2a26; muted text `--muted` #6b6358.
- Crayons: red `--red` #d9402f, blue `--blue` #2f6fb5, green `--green` #3f9b5a. The title uses all three (Cray / on / Breath).
- The drawing palette is not part of the theme: it is the game's fixed list in `public/app.js` (`COLORS`) and must not change.

## Themes (dark and light)

Dark is the default; light is the original paper. Both themes share every rule in `public/style.css`. Only the custom properties change: `:root` holds the light values and `:root[data-theme=dark]` overrides them with warm charcoal paper (#2a2420), a lighter ink and lightened crayons. Never hard-code a colour in a rule; add a variable to both blocks instead. The extra variables are `--on` (text on a solid crayon button), `--field` (input and chip fill), `--hold` (placeholder), `--dot` (paper texture), `--shade` and `--drop` (shadows) and `--veil` (the overlay over the canvas). Body text, headings and button labels meet WCAG AA in both themes.

`public/theme.js` is loaded as a blocking script in `<head>`, before the stylesheet, so the theme is set before first paint with no flash. It reads `localStorage['doodle-dash.theme']` (`dark` or `light`), falls back to dark when nothing is stored (the system light/dark preference is deliberately ignored), sets `data-theme` on `<html>` and updates `meta[name=theme-color]`. It is a file, not an inline script, because the Content-Security-Policy forbids inline scripts. The landing page toggle (`#themeBtn`, "Dark" / "Light", `aria-pressed` true in dark) calls `window.__theme.set()` from `app.js`.

The drawing canvas and the game-over drawings stay white in both themes so every player sees the drawn colours the same way; the dark paper only frames them.

## Card component

```html
<div class="opt p">            <!-- p = red, m = blue, j = green -->
  <h2>Heading</h2>             <!-- Schoolbell, in the card colour -->
  <p>One plain line.</p>
  <button class="go">Action</button>   <!-- full-width solid button in the card colour, 56px tall -->
</div>
```

The rough crayon outline is a `::before` border run through the inline SVG filter `#rough`; the title uses `#wax`. Both filters are defined once at the top of `index.html`. Never put a filter or transform on the game canvas or its wrapper: it would distort the drawing coordinates.

The three landing cards (Public lobby, Private game, Join with a code) are deliberately identical in size and weight. Keep it that way; no card gets a bigger or special button.

## Buttons and inputs

- `button.go`: solid fill in the surrounding `--c` colour, white text.
- `button.ghost` (and plain `button`): ink outline on paper. Used for Leave, tools and secondary actions.
- Every tap target is at least 44px (`--tap`). Use real buttons, never text links.
- Inputs get a 3px outline in `--c`; the name field is a hand-written underline.

## Other rules

- No emojis, logos, photos or stock art. Status tags (drawing, got it) are small coloured text pills.
- `.slot` is an empty, zero-height block on the landing page and game-over overlay, reserved for a future ad. Leave it empty until ads are designed.
- `prefers-reduced-motion` turns off transitions and button press movement.
- Cache busting: `index.html` references every asset with `?v=<version>`. Bump the one version string everywhere when CSS or JS changes; a test checks the versions match and every asset is served.
