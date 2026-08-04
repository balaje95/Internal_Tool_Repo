# Zuper Internal Tools — Chrome extension

Puts the Internal Tools Dashboard in a Chrome **side panel** beside the Zuper web app.
A floating orange **Zuper Tools** button appears on Zuper pages; click it (or press
`Alt+Z`, or click the toolbar icon) and the panel opens with a searchable list of every
tool. Pick one and it renders in the panel — Zuper stays visible next to it.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open any `*.zuper.co` / `*.zuperpro.com` page. The button appears bottom-right.

Chrome 116 or newer is required (`chrome.sidePanel.open`).

## How it works

The extension is a **thin launcher**. It ships no copies of the tools — each one is
loaded in an iframe from the live dashboard (`https://internal-tool-repo.vercel.app`
by default).

That is a deliberate choice, for three reasons:

- **MV3 forbids inline scripts on extension pages** (`script-src 'self'`). All 11 tools
  are single-file HTML with inline `<script>` blocks, so bundling them would mean
  extracting every script from every tool — including the ~7 MB training deck generator.
- **Tools keep their own origin.** Running from `internal-tool-repo.vercel.app` means
  their existing `fetch` calls to `*.zuperpro.com` behave exactly as they do in a normal
  tab. Nothing about CORS or auth changes.
- **Updating a tool is a `git push`,** not an extension re-publish.

The tool list is read from `<base>/assets/tools.config.js` and cached in
`chrome.storage.local`, so **adding a tool to the dashboard makes it appear in the panel
with no extension change**. The panel renders the cached list instantly, then refetches
in the background and re-renders only if it changed. `tools.fallback.json` is a snapshot
used only on a very first run with no network.

### Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest — `sidePanel` + `storage`, hosts scoped to Zuper + the dashboard |
| `background.js` | Opens the panel (toolbar click, `Alt+Z`, or a message from the page button) |
| `sidepanel.html/.css/.js` | The launcher list and the iframe tool viewer |
| `content.js` | The floating in-page button, in a shadow root |
| `uid-hook.js` | MAIN-world observer of the app's API responses (see UID badges below) |
| `uid-badges.js/.css` | Injects the per-row UID chips |
| `options.html/.css/.js` | Dashboard URL, button and badge settings, diagnostics |
| `tools.fallback.json` | First-run snapshot of the tool list |
| `icons/` | Logomark PNGs, generated from `assets/logos/zuper-logomark.svg` |

## Record UID badges

On Zuper listing pages each row gets a small monospace chip showing the first 8
characters of its record UID; clicking copies the full UID. It saves opening a record
just to read its id out of the address bar before pasting it into Data Manager or one of
the mappers.

A **Show/Hide UID** pill sits directly above the floating launcher and toggles them for
every page, showing how many rows on the current page got a badge. It and the options
checkbox are the same switch — both write one setting, and the badges add or strip
themselves in response, so the two can never disagree.

Chip and pill colours follow **the brightness of the page behind them**, not
`prefers-color-scheme`. Keying them off the OS theme made a light Zuper UI on a
dark-themed desktop render chips at `rgba(255,255,255,0.06)` on a white table row — a
contrast ratio well under 1.5:1.

Zuper's markup is not something this extension can know, and hard-coded selectors would
break the first time the app is restyled — so row detection is selector-agnostic (all
`<table>`s, all ARIA grids, plus a repeated-sibling sweep for card layouts) and UIDs are
resolved in two layers:

1. **Exact** — a UUID already present in the row's own markup, normally a detail-page
   link. Solid border.
2. **Matched** — paired against records captured from the responses the app already
   fetched for that page, scored on shared rare tokens. **Dashed** border.

Layer 2 only labels a row when one record wins by a clear margin. Two customers with the
same name and email leave *both* rows unbadged, and a row with no corresponding record
stays bare. That asymmetry is deliberate: a missing badge costs a click, while a wrong
one gets pasted into a bulk delete.

`uid-hook.js` needs `world: "MAIN"` because content scripts run in an isolated world and
cannot see the page's `fetch`/`XMLHttpRequest`. It is strictly a read-only observer —
requests are never altered, the response body is read from a `clone()` so the app still
gets its own untouched copy, every hook falls through to the original function on error,
and nothing is transmitted anywhere. Turning off **"Also match UIDs from the app's own
API responses"** in options unhooks it entirely and leaves only layer 1.

Both behaviours are toggleable in options, and the **Diagnostics** card there reports the
last scan (rows found, how many were badged by each layer, records captured) — that is
the thing to copy if a page comes up unbadged.

## Permissions, and why each is needed

| Permission | Reason |
| --- | --- |
| `sidePanel` | Open and host the panel |
| `storage` | Settings + the cached tool list |
| `*://*.zuper.co/*`, `*://*.zuperpro.com/*` | Inject the button and the UID badges; read the active tab's URL for the context strip |
| `https://internal-tool-repo.vercel.app/*` | Fetch the tool list and frame the tools |

There is no `tabs` permission — the context strip relies on the host permissions above to
see the active tab's URL, and reads **nothing** from Zuper's DOM. No API key or account
data passes through `background.js`; each tool authenticates itself exactly as it does
in a normal tab.

`zuper.co` and `www.zuper.co` are excluded, so the button never shows on the public
marketing site.

## Known limitations

- **Storage is partitioned.** Chrome scopes an iframe's `localStorage` to the embedding
  site, so a tool's saved state in the panel is a separate bucket from the same tool in a
  normal tab. Anything you saved in a tab (remembered region, delete history) will not be
  visible in the panel, and vice versa. Use **↗ Open in a full tab** when you want the
  tab-side state.
- **If the dashboard's login gate is ever switched on**, the panel will show the login
  page instead of the tool. `api/login.js` issues `zuper_auth` as `SameSite=Lax`, which
  Chrome will not send on a cross-site iframe request. Fixing it means changing that
  cookie to `SameSite=None; Secure`.
- **A custom dashboard URL needs CORS.** Only the two hosts in `host_permissions` are
  granted outright; any other base URL you set in options must send
  `Access-Control-Allow-Origin` for the tool list to load. (Vercel already sends `*`.)
- **Wide tools are cramped.** The dashboard builder and data manager have dense tables;
  drag the panel edge wider, or open them in a tab.
- The context strip is URL-only — it shows the host, a path hint and any record UID it
  finds, and cannot detect account or region.

## Publishing

Loading unpacked is the intended distribution for an internal tool. To share it, zip the
`extension/` folder, or upload it to the Chrome Web Store as a **private/unlisted** item
restricted to the Zuper workspace — do not list it publicly, since it hard-codes internal
URLs.
