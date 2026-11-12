# Preview sanitizers

The three HTML sanitizers serve different inputs and should stay separate.

| Input | Policy | Reason |
|---|---|---|
| Markdown | `markdownPolicy` in `tabtopd/markdown.go` | Goldmark omits raw HTML. Bluemonday then permits a limited set of generated elements, heading IDs and classes used by task lists, syntax highlighting, math and Mermaid. Trusted frame libraries render the math and diagrams afterwards. |
| EPUB chapters | XML rewriting and `epubPolicy` in `tabtopd/epub.go` | The XML walk selects chapter elements, rewrites book-relative links and picture references, and prefixes IDs. Bluemonday checks that result. Original scripts, styles, forms and embedded documents do not pass through. |
| Raw HTML | `cleanHTML` in `tabtopd/md-frame.js` | An inert template is read and a fresh allowlisted DOM is constructed. Formatting attributes survive; stylesheet/style/media nodes become inert descriptors for the resource brokers. CSS Tree parses CSS before scoped, restricted rules and rewritten URLs enter the document. The original nodes are never inserted into the displayed document. |

All three render inside an opaque sandbox with a restrictive CSP; see the frame
headers in `tabtopd/page_assets.go`. The parent checks message sources, brokers local
pictures, and prompts before opening external links. These controls supplement
the sanitizers.

Markdown and raw HTML also use `preview-pictures.js` to bound each render to
100 image occurrences and 64 MiB of delivered image bytes, with a separate
64 MiB source-cache cap and a 20 MB per-file cap. Fragment/path aliases share a
source read; each repeated occurrence still spends the delivery budget.
EPUB chapters use the same cumulative cache/delivery budgets, retaining the
server's 20 MiB per-picture cap. A repeated book picture is read once per
chapter; each occurrence still spends the delivery budget. Starting another
chapter, another render or closing the frame aborts its outstanding picture
reads. Replies transfer their buffers instead of cloning them again.

Embedded HTTP(S) resources are blocked by default. A three-state glyph just
before Download appears for web images in HTML, Markdown and EPUB, and for HTML
stylesheets, CSS references and ordinary audio/video sources. Clickable links
retain their confirmation flow and do not reveal this control. PDF links are
also excluded; the PDF renderer does not fetch embedded remote image streams.
PDF batch image editing keeps parsing in that same opaque sandbox. Its parent
requests only bounded page rasters; replies contain PNG blobs and validated
dimensions. The batch editor receives no original PDF objects or executable
markup. Rebuilt PDFs contain raster image pages, and this workflow does not
write to the source PDF or widen the frame's CSP.
EPUB's original styles and media remain outside its XML sanitizer's allowlist;
Markdown continues to omit raw HTML.

HTML's **Proxy** mode uses the authenticated E2E tunnel for stylesheets, imports,
fonts, background images and media, without saving files. CSS Tree 3.1.0 is
vendored with its MIT license and archive integrity in `tabtopd/third-party/`.
`preview-css.js` rejects opaque parser recovery nodes,
unknown URL-bearing functions and unsupported rules/properties. Selectors are
scoped to #doc; custom-property URLs and var fallbacks are also rewritten; font faces are reconstructed with brokered URLs. Import cycles,
up to 8 nesting levels, 16 fetched/imported sheet expansions, 2 MiB of
cumulative CSS input (including inline declarations), 50,000 AST work units and 2 MiB of generated CSS bound the processing. Each sheet is at
most 512 KiB. Inline style blocks do not consume the fetched-sheet count,
including empty blocks; byte/work budgets still apply. Stylesheet media
conditions are retained on processed styles and native Direct links. Disabled,
alternate and non-CSS stylesheets stay inactive. Qualified imports preserve
named/anonymous layers, layer ordering, supports conditions and media queries.
Fonts are at most 8 MiB each and at most 8 files per render. Static
CSS/font/background resources use a separate 100-request/64 MiB cache/delivery
budget, in addition to the existing picture budgets. Raw HTML nodes are never
inserted into the live document, and only processed CSS is active in Proxy mode.

Remote media metadata probes use bytes=0-0. Playback reads at most 1 MiB per
E2E request, validating status 206, exact Content-Range and body length, total
size and MIME type. Strong ETag or Last-Modified validators are pinned when
provided, using If-Range; without a validator only size/type consistency can be
checked. A server ignoring Range is rejected rather than downloaded wholesale.
At most eight players are created per document. They use the trusted parent's
existing service-worker transport, over inert, clipped placeholders in the
opaque frame. Frames never receive credentials. Scroll/resize messages adjust
player positions within the preview body. Closing or replacing a render aborts
all reads, removes native players and releases object URLs. Proxy media requires
HTTPS/localhost and service workers; there is no whole-file remote fallback.

All proxy resource types need WEB_FETCH and use its DNS, dial and redirect
policy, but reach only public addresses unless WEB_PREVIEW_FETCH_PRIVATE=1:
the document picks these URLs, so WEB_FETCH_PRIVATE never applies to them. They omit credentials, and have a 30-second request deadline and
four concurrent responses across the gateway. Static response caps are 20 MiB
for images, 512 KiB for CSS and 8 MiB for fonts; font signatures are checked.
Direct frames alone allow native HTTP(S) styles, fonts, images and media; browser
CORS, codec support and transfer behavior apply in that mode. **No external**
and **Proxy** frames cannot make HTTP(S) resource loads. Scripts, event handlers,
forms, frames, active objects and automatic navigation remain blocked in every
mode. Direct mode can apply native stylesheets inside the opaque frame, while
the application and its credentials remain outside that frame.

Saved HTML link recovery is implemented in `preview-html-links.js`. The
renderer accepts only declared `data-href`/`data-ga-content-link` destinations,
never original click handlers. Absolute destinations must be HTTP(S) without
URL credentials. Relative declared destinations need an explicit source URL
(base/canonical/OpenGraph/saved-from metadata), or one unambiguous URL whose
absolute self-links match at least two distinct anchors in that file. These
hints resolve link destinations only: they do not authorize external loads or
rewrite saved local image paths. Recovered links still use the URL confirmation
dialog. Ambiguous origins and executable destinations stay inert. HTML URL
whitespace is normalized before classifying links and resources.

When changing a policy, check that scripts from the input never survive:

- Script elements, event handlers, executable URLs and foreign namespaces do not enter the displayed DOM.
- Base URLs, refresh directives, forms, embedded pages and active objects cannot change navigation or submit data.
- Proxy resource URLs use typed, bounded brokers; arbitrary network loads remain blocked by CSP.
- Frame sandboxing and source checks remain in place. External links pass through the parent confirmation dialog.
- Run the relevant independent browser groups (`html`, `markdown`, `epub`) to exercise hostile content, links and rendering. Markdown's trusted diagram/math output is distinct from input HTML.

See [development](development.md) for the commands and [file previews](downloads.md)
for the user-facing behavior.
