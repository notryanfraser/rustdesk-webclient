# Ferry brand kit

**Ferry**: *Cross over to any desktop.*
An open-source web client for RustDesk servers.

## The mark
A small ferry whose cabin is a screen with a cursor, riding a wave. Iron-oxide orange nods to RustDesk (rust = iron oxide; *Fe*rry) without borrowing its name or logo.

| File | Use |
|---|---|
| `logo/ferry-mark.svg` | Primary app icon (navy tile) |
| `logo/ferry-mark-rust.svg` | Alternate icon on a rust tile |
| `logo/ferry-mark-transparent.svg` | Mark without the tile, for light backgrounds |
| `logo/ferry-lockup-light.svg` / `.png` | Icon + wordmark for light backgrounds |
| `logo/ferry-lockup-dark.svg` / `.png` | Icon + wordmark for dark backgrounds |

All wordmark text is converted to outlines, so the SVGs render the same everywhere with no font dependency.

## Palette

| Name | Hex | Role |
|---|---|---|
| Iron Oxide | `#E0531F` | Brand accent: hull, CTAs, tagline |
| Harbor Night | `#0E1A2B` | Primary dark / icon tile |
| Sea Foam | `#F5EFE6` | Light background, text on dark |
| Tide | `#2BB3A3` | Secondary accent: waves, success states |
| Harbor Mist | `#8FA3B8` | Secondary text on dark |
| Slate | `#4A5A6E` | Secondary text on light |

## Typography
- **Headings / wordmark:** Inter Display Bold (tracking -2.5%)
- **UI & body:** Inter Regular / Medium
Both are free under the SIL Open Font License.

## Usage notes
- Keep clear space around the mark of at least ¼ of its width.
- Don't recolor the hull or change the wave to another color than Tide or Sea Foam.
- Write "works with RustDesk servers" in copy; keep "RustDesk" out of the product name and logo.

## Where it's used
- **App:** favicon, PWA icons and the connect-screen mark live in `app/src` (`favicon.svg`, `favicon.ico`, `icons/`).
- **README:** the banner in `.github/assets/` switches between light and dark.
- **Social preview:** `.github/assets/social-preview.png` (1280×640). GitHub needs a PNG or JPG, uploaded under Settings → General → Social preview.
- **Accent in the UI:** `#E0531F` is too light for text on white (3.4:1), so the app uses `#B8400F` on light and `#F06A3A` on dark. The mark keeps the brand colors.
