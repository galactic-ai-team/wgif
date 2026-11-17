# Opening a .wgif: what works where

A `.wgif` is a ZIP (media type `application/vnd.wgif+zip`). Operating systems do not know the
type, so "tap the file and the player opens" depends on what each platform lets a web app do.
This page is the honest list for the Phase One web player (apps/player).

| How | iPhone / iPad (Safari) | Android (Chrome) | Desktop Chrome / Edge | Desktop Safari / Firefox |
| --- | --- | --- | --- | --- |
| **Open .wgif** button → system picker | ✅ Files picker shows every file; pick the .wgif (fixed in this change) | ✅ picker unfiltered | ✅ filtered to .wgif | ✅ filtered to .wgif |
| Drag a file onto the page | iPad only (Split View drag) | — | ✅ | ✅ |
| Tap / double-click the file itself | ❌ iOS cannot route a file type to a website or Home Screen web app. Files shows a blank icon and Quick Look cannot preview it | ❌ Files app opens nothing (no web-app file handlers on Android) | ✅ after **installing** the player (⊕ Install in the address bar): "Open with → WGIF Player", or set it as default for .wgif (manifest `file_handlers` + `launchQueue`) | ❌ |
| Share the file **to** the player | ❌ iOS has no Web Share Target | ✅ after **installing** the player (Add to Home screen): Share → WGIF (manifest `share_target`, the service worker receives it) | — | — |
| A link: `…/?src=<https URL of a .wgif>` | ✅ | ✅ | ✅ | ✅ |
| **Share / Save to Files…** after export | ✅ share sheet (Save to Files, AirDrop, Messages) when Safari allows the file | shown only if Chrome allows sharing that file type (it usually does not for ZIP); the download works | — | — |
| **Save preview image** | ✅ share sheet → Save Image to Photos, or download | ✅ share or download | download | download |

## Why "Open .wgif" did not work on iPhone

The picker was `<input type="file" accept=".wgif,application/vnd.wgif+zip,application/zip">`.
iOS turns `accept` into file types (UTIs). `.wgif` has no registered type on iOS, and a file
Safari saved as `galactic-court-edit.wgif` is not a "ZIP archive" to iOS either, so the Files
picker greyed it out and it could not be chosen. The player now sets no `accept` on phones and
tablets (src/opening.ts `pickerAccept`) and checks the bytes instead: a world starts with the
ZIP signature, and an image or other file gets a plain message saying what it is.

## Links: `?src=`

`https://<player>/?src=https://example.com/my-world.wgif` fetches that file and opens it. Only
`https:` (or the player's own origin / localhost over http) is accepted; `data:`, `blob:`,
`file:` and `javascript:` are refused, and files over 64 MiB are not fetched. The host must allow
cross-origin downloads (CORS). The world itself still never fetches anything (SPEC §4). Relative
links work too: `?src=samples/court.wgif` opens the bundled court.

## Export with an image

* An export of an **editable** world renders the edited world from its overview camera
  (480×288, falling back to 400×240 or 320×192 so it stays within SPEC §4's ≤ 512 px and
  ≤ 256 KiB) and writes it to `entry.preview` (`preview.png`). The file hash, size and
  `files[]` entry are recomputed by `exportEditedWorld`, and the export is re-validated before
  it is handed out. The history note ends with "new preview image".
* An export of a **layered** world never changes base files, so the preview stays as it was and
  the base signature keeps verifying.
* A **signed editable** world already loses its signature when its content changes; the new
  preview only goes in when other base content changed too, never as the sole change.
* **Save preview image** writes a 1024×614 PNG of the current world (share sheet on phones,
  download elsewhere). It is an ordinary image, so Files and Photos show it.

The `.wgif` itself still shows a generic icon in Files: iOS draws thumbnails only for types it
or an installed app knows. A PNG/ZIP "polyglot" that shows a thumbnail is not allowed by v0.1
(manifest.json must be the first bytes of the file); see
`wgif-packets/outbox/gpt6_png_polyglot_proposal.txt` for the format-lane proposal.
