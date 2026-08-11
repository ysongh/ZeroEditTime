# Phase 9A image-overlay manual verification

Use this checklist for a browser end-to-end pass. Checking an item records a
manual observation; the document itself does not claim that the check passed.

## Setup

1. Run `pnpm dev` and open the printed local URL in a supported desktop browser.
2. Use a video at least 20 seconds long with clear speech and audio. Create one
   cut, then generate captions so layering, cut alignment, lip-sync, and audio
   can be checked together.
3. Prepare an opaque PNG, a transparent PNG, a JPEG, a WebP, an unsupported
   file such as `.txt`, and a corrupted image file.
4. Record the run before checking items:

   - Date:
   - Browser/version:
   - Operating system:
   - Source video:
   - Notes/issues:

## Upload

- [ ] PNG uploads and its thumbnail displays correctly.
- [ ] JPEG uploads and its thumbnail displays correctly.
- [ ] WebP uploads and its thumbnail displays correctly.
- [ ] Unsupported files are rejected with a visible, actionable message.
- [ ] Corrupted images are rejected without crashing the editor.
- [ ] Each valid asset reports the correct natural dimensions.

## Preview

- [ ] Add an image at the playhead; it appears at the expected position and time.
- [ ] The image is visible only inside its half-open source-time range; seeking
      just before, inside, and at the end updates visibility correctly.
- [ ] Play across a timeline cut spanned by the image; retained footage stays aligned
      and the image does not gain a cut-boundary fade or flash.
- [ ] A full-frame cutaway displays correctly.
- [ ] Picture-in-picture uses the expected bottom-right size and safe margin.
- [ ] Logo uses the expected top-right size and remains through its configured end.
- [ ] Dragging moves the selected image and commits once when released.
- [ ] Corner resizing stays in-frame and preserves aspect ratio; Shift unlocks it.
- [ ] Contain, cover, and stretch each match their labels.
- [ ] Opacity changes are visible and match the configured percentage.
- [ ] Fade-in and fade-out work, including a short overlay with overlapping fades.
- [ ] Several overlapping images render in the configured back-to-front order.
- [ ] Caption preview text stays visually above every image layer.

## Timeline

- [ ] Every overlay has a labeled block at its original source start and end.
- [ ] Dragging a block changes its source timing without changing its duration.
- [ ] Left and right handles trim the expected boundary and enforce the minimum duration.
- [ ] Clicking a block selects the overlay and seeks to its start.
- [ ] Adding or changing timeline cuts does not mutate any overlay block's source timing.

## Export

- [ ] Export with one overlay succeeds and matches its preview placement/timing.
- [ ] Export with several overlapping overlays preserves layer order.
- [ ] A transparent PNG retains its transparent regions and configured opacity.
- [ ] With caption burn enabled, captions appear above image overlays.
- [ ] With caption burn disabled, no captions are burned and overlays remain present.
- [ ] A cut entirely before an overlay shifts it to the correct output time.
- [ ] A cut inside an overlay keeps the image continuous across retained footage.
- [ ] Several cuts inside one overlay produce no disappearance, flash, or interior fade.
- [ ] Speech/audio follows the same kept ranges with no new drop, duplication, or join
      click beyond the existing loudness-normalization and declick behavior.
- [ ] Lip-sync remains correct before and after every cut.
- [ ] The loading/export progress states update and the downloaded MP4 opens normally.
- [ ] Trigger one controlled export failure (for example, block the first engine load
      in browser developer tools); the UI returns to idle and shows an actionable error.
- [ ] A successful export still works after the controlled failure.

## Completion

- [ ] Record any failed item with reproduction steps, browser console output, and a
      short source/asset description.
- [ ] Re-run `pnpm test`, `pnpm build`, and `pnpm lint` after fixing any regression.
