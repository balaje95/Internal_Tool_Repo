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

The **Show/Hide UID** control mounts **inline in Zuper's own toolbar**, immediately after
the listing's view chip ("All Customers"), which is where you are already looking. The
anchor is found by its visible text rather than a class name — Zuper's class names are not
ours to depend on — falling back to "Create New View", and then to a floating pill above
the launcher if neither is present. When the inline control mounts, the floating pill hides
itself so there is only ever one.

It renders in its own shadow root with `adoptedStyleSheets`, so the surrounding toolbar CSS
cannot restyle it and its own styles cannot leak out. Zuper is a single-page app and
re-renders that toolbar on navigation, so a debounced observer re-mounts it, guarding
against duplicates.

Either control shows how many rows on the current page got a badge, and doubles as the
status readout: a pulsing dot while records are being fetched, `!` when the lookup failed.
The controls and the options checkbox are all one switch — they write a single setting, and
the badges add or strip themselves in response, so they can never disagree.

### Copying UIDs in bulk

Beside the toggle sits **Copy N UIDs**. It reads **Zuper's own row checkboxes**, so the
selection that counts is the one already on screen: tick the rows you want and copy just
those. With nothing ticked it copies every UID on the page. One per line by default —
**hold Shift** for comma separated.

Ticking a box changes no markup, so the count is kept live from `change`/`click` rather
than the DOM observer, and the list itself is requested at click time so a box ticked a
moment earlier is always included.

### Filling the API key into tools

With **Fill this key into tools opened in the side panel** on (default), opening a tool in
the panel populates its API key field from the key in options — no more pasting the same
key into eleven tools.

The tool half is `assets/zuper-panel-bridge.js`, included by all 11 tools next to
`back-link.js`. It is deliberately constrained, since it handles a credential:

- **Write only.** It never reads a key out of a page and never posts one anywhere. Its only
  outbound message is a contentless "ready" ping.
- **Extension-origin only.** Messages are ignored unless the parent frame is
  `chrome-extension://`, so an ordinary web page cannot drive it by framing a tool.
- **Never overwrites.** A value already in the field wins.
- **Never connects.** It fills the field and stops; clicking Connect stays deliberate, so
  no tool fires API calls unasked.
- **Refuses ambiguity.** The field is found by shape rather than a per-tool id list
  (`api key` in the id/name/placeholder/label, or a single lone password box). Two password
  fields and it does nothing rather than fill the wrong one.

Outside the panel it is inert — unframed pages return immediately, so a tool opened in a
normal tab behaves exactly as before.

Chip and pill colours follow **the brightness of the page behind them**, not
`prefers-color-scheme`. Keying them off the OS theme made a light Zuper UI on a
dark-themed desktop render chips at `rgba(255,255,255,0.06)` on a white table row — a
contrast ratio well under 1.5:1.

Zuper's markup is not something this extension can know, and hard-coded selectors would
break the first time the app is restyled — so row detection is selector-agnostic (all
`<table>`s, all ARIA grids, plus a repeated-sibling sweep for card layouts) and UIDs are
resolved from three sources:

1. **API lookup (primary)** — the module is read from the page's route, its records are
   fetched from the Zuper API with a saved key, and each row is matched to its record.
   This is the path that works on Zuper's real listings, where rows carry no UID at all.
   Needs an API key in options. **Dashed** border.
2. **Exact** — a UUID already present in the row's own markup, normally a detail-page
   link. No key needed. Solid border.
3. **Observed** — records captured from responses the app already fetched for that page.
   A free fallback for routes the module map does not cover. **Dashed** border.

The API fetch runs in the service worker, not the content script: a content-script fetch
is treated as coming from the page's origin and would be blocked by CORS. Endpoints, uid
keys and the paginated response shape are taken from Data Manager's `MODULES`, which is
the proven reference for this API. Records are cached for 10 minutes per module, and
reduced to `{uid, fields}` on arrival rather than held whole.

Matching tolerates **truncated cells**. Listings ellipsise long values
(`hannah@hiredgunsre…`), so the visible token can never equal the stored one; a
short-prefix index recovers those at a lower weight — enough to corroborate a match, not
enough to decide one alone.

Layer 2 only labels a row when one record wins by a clear margin. Two customers with the
same name and email leave *both* rows unbadged, and a row with no corresponding record
stays bare. That asymmetry is deliberate: a missing badge costs a click, while a wrong
one gets pasted into a bulk delete.

`uid-hook.js` needs `world: "MAIN"` because content scripts run in an isolated world and
cannot see the page's `fetch`/`XMLHttpRequest`. It is strictly a read-only observer —
requests are never altered, the response body is read from a `clone()` so the app still
gets its own untouched copy, every hook falls through to the original function on error,
and nothing is transmitted anywhere. Turning off **"Also match UIDs from the app's own
API responses"** makes it inert: the wrappers stay installed but return before touching
any response, so nothing is read, cloned or parsed.

The wrappers deliberately stay installed rather than restoring the originals. Removing
them made "off" a one-way door — nothing re-wrapped on the way back, so re-enabling the
badges within a page could never resume matching.

It also buffers what it captures and replays it when `uid-badges.js` announces itself.
`postMessage` is not queued, and the hook runs at `document_start` while the badge script
runs at `document_idle`, so on a normal page load the listing response lands in that gap
and would otherwise be lost entirely.

Both behaviours are toggleable in options, and the **Diagnostics** card there reports the
last scan (rows found, how many were badged by each layer, records captured) — that is
the thing to copy if a page comes up unbadged.

## Permissions, and why each is needed

| Permission | Reason |
| --- | --- |
| `sidePanel` | Open and host the panel |
| `storage` | Settings + the cached tool list |
| `*://*.zuper.co/*`, `*://*.zuperpro.com/*` | Inject the button and the UID badges; fetch records for UID lookup; read the active tab's URL for the context strip |
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
- **Reloading the extension orphans open tabs.** A reloaded unpacked extension leaves the
  content scripts in already-open tabs disconnected — `chrome.storage` throws and its
  change listeners are dead. The pill detects this and tells you to refresh rather than
  appearing to do nothing, but the fix is always `Ctrl+Shift+R` on the Zuper tab.
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
