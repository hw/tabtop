# Preview sanitizers

The three HTML sanitizers serve different inputs and should stay separate.

| Input | Policy | Reason |
|---|---|---|
| Markdown | `markdownPolicy` in `tabtopd/markdown.go` | Goldmark omits raw HTML. Bluemonday then permits a limited set of generated elements, heading IDs and classes used by task lists, syntax highlighting, math and Mermaid. Trusted frame libraries render the math and diagrams afterwards. |
| EPUB chapters | XML rewriting and `epubPolicy` in `tabtopd/epub.go` | The XML walk selects chapter elements, rewrites book-relative links and picture references, and prefixes IDs. Bluemonday checks that result. Original scripts, styles, forms and embedded documents do not pass through. |
| Raw HTML | `cleanHTML` in `tabtopd/md-frame.js` | An inert template is read and a fresh allowlisted DOM is constructed. Only restricted formatting attributes and CSS properties survive; image URLs become references for the picture broker. The original nodes are never inserted into the displayed document. |

All three render inside an opaque sandbox with a restrictive CSP; see the frame
headers in `tabtopd/e2e.go`. The parent checks message sources, brokers local
pictures, and prompts before opening external links. These controls supplement
the sanitizers.

When changing a policy, check that scripts from the input never survive:

- Script elements, event handlers, executable URLs and foreign namespaces do not enter the displayed DOM.
- Base URLs, refresh directives, forms, embedded pages and active objects cannot change navigation or submit data.
- Resource URLs use the existing picture broker; arbitrary network loads remain blocked by CSP.
- Frame sandboxing and source checks remain in place. External links pass through the parent confirmation dialog.
- Run the relevant independent browser groups (`html`, `markdown`, `epub`) to exercise hostile content, links and rendering. Markdown's trusted diagram/math output is distinct from input HTML.

See [development](development.md) for the commands and [file previews](downloads.md)
for the user-facing behavior.
