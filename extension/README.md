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
| `options.html/.css/.js` | Dashboard URL, button visibility/position, clear cache |
| `tools.fallback.json` | First-run snapshot of the tool list |
| `icons/` | Logomark PNGs, generated from `assets/logos/zuper-logomark.svg` |

## Permissions, and why each is needed

| Permission | Reason |
| --- | --- |
| `sidePanel` | Open and host the panel |
| `storage` | Settings + the cached tool list |
| `*://*.zuper.co/*`, `*://*.zuperpro.com/*` | Inject the button; read the active tab's URL for the context strip |
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
