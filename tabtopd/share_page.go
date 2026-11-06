package main

// The pages a share link shows a browser. Someone opening a download link
// in a browser gets a page with the file's name and a Download button,
// rather than the file: chat apps and mail scanners that fetch a link
// pasted into them, to preview or check it, then don't use up a download.
// The button posts to the link, which counts the download and sends the
// browser on to the file (see serveShare). wget, curl and the like, which
// don't ask for HTML, get the file at once, as before. An upload link
// shows a browser a form to upload files with (see serveUploadLink).
//
// Nothing on these pages comes from the files themselves but their names,
// escaped; the upload page's one script, which shows how far uploads have
// got, is allowed by its hash.

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"strings"
	"time"
)

// wantsPage reports whether r asks for a page: a browser opening a link
// says text/html in Accept. wget and curl say */*, or nothing.
func wantsPage(r *http.Request) bool {
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html")
}

// uploadScript sends the files picked on the upload page a file at a time,
// each in pieces (see share_chunks.go), showing how far each has got. If
// the connection is lost, it asks where the file got to, and carries on
// from there, trying again for a while; told it has all of it, it sends
// the last byte again, which a saved upload answers as it did (see
// linkDone). Without it, the form posts them
// all at once. It has no comments: html/template drops them from a script,
// which would change its hash.
const uploadScript = `
const PIECE = 8 * 1024 * 1024;
const GIVE_UP = 15 * 60 * 1000;
const form = document.querySelector("form.upload");
const input = form.querySelector("input");
const button = form.querySelector("button");
const list = document.getElementById("sent");
form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const files = [...input.files];
    if (!files.length) {
        return;
    }
    input.disabled = button.disabled = true;
    for (const f of files) {
        const bar = Object.assign(document.createElement("progress"), { max: 1, value: 0 });
        const note = document.createElement("span");
        const li = document.createElement("li");
        li.append(f.name + " ", bar, note);
        list.append(li);
        try {
            li.textContent = await send(f, (x, why) => {
                bar.value = x;
                note.textContent = why ? " " + why : "";
            });
        } catch (err) {
            li.textContent = f.name + ": " + err.message;
            li.className = "error";
        }
    }
    form.reset();
    input.disabled = button.disabled = false;
});
function request(method, url, body, headers, progress) {
    return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open(method, url);
        for (const [k, v] of Object.entries(headers)) {
            x.setRequestHeader(k, v);
        }
        if (progress) {
            x.upload.onprogress = (e) => progress(e.loaded);
        }
        x.onload = () => {
            if (x.status >= 500 && x.status !== 507) {
                reject(Object.assign(new Error("the server answered " + x.status), { lost: true }));
                return;
            }
            resolve({ status: x.status, text: x.responseText.trim(), offset: Number(x.getResponseHeader("Upload-Offset")) });
        };
        x.onerror = () => reject(Object.assign(new Error("the connection was lost"), { lost: true }));
        x.send(body);
    });
}
async function send(f, progress) {
    const name = encodeURIComponent(f.name);
    if (!f.size) {
        const r = await request("PUT", name, f, {});
        if (r.status >= 300) {
            throw new Error(r.text);
        }
        return r.text;
    }
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    const url = name + "?u=" + id;
    let offset = 0;
    let since = Date.now();
    let wait = 1000;
    for (;;) {
        if (offset >= f.size) {
            offset = f.size - 1;
        }
        const end = Math.min(offset + PIECE, f.size);
        try {
            const r = await request("PUT", url, f.slice(offset, end), { "Content-Range": "bytes " + offset + "-" + (end - 1) + "/" + f.size },
                (n) => progress((offset + n) / f.size));
            if (r.status === 201) {
                return r.text;
            }
            if (r.status === 204 || r.status === 409) {
                if (r.offset > offset) {
                    since = Date.now();
                    wait = 1000;
                }
                if (r.status === 409) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
                offset = r.offset;
                progress(offset / f.size);
                continue;
            }
            throw new Error(r.text);
        } catch (err) {
            if (!err.lost || Date.now() - since > GIVE_UP) {
                throw err;
            }
            progress(offset / f.size, "(connection lost, trying again…)");
            await new Promise((resolve) => setTimeout(resolve, wait));
            wait = Math.min(wait * 2, 30000);
            try {
                const h = await request("HEAD", url, null, {});
                if (h.offset > offset) {
                    since = Date.now();
                }
                offset = h.offset;
            } catch {
            }
        }
    }
}
`

var (
	uploadScriptHash = func() string {
		sum := sha256.Sum256([]byte(uploadScript))
		return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	}()
	// sharePageCSP is for the pages: their own styles, a form that posts
	// back to the link, and on the upload page, its script, which talks
	// only to the link.
	sharePageCSP = "default-src 'none'; style-src 'unsafe-inline'; script-src " + uploadScriptHash +
		"; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
)

const sharePageCSS = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --line: #ddd; --accent: #1a73e8; --muted: #666; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8ea; --bg: #1c1c1e; --line: #3a3a3c; --accent: #8ab4f8; --muted: #a0a0a5; } }
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; color: var(--fg); background: var(--bg); }
main { max-width: 32rem; margin: 12vh auto 2rem; padding: 0 16px; }
h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 .25rem; overflow-wrap: anywhere; }
p { margin: .5rem 0; }
.meta, .small { color: var(--muted); }
.small { font-size: 13px; margin-top: 2rem; }
.error { color: #c5221f; }
@media (prefers-color-scheme: dark) { .error { color: #f28b82; } }
form { margin: 1.25rem 0; display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
input[type=file] { font: inherit; max-width: 100%; }
button { font: inherit; padding: .5rem 1.4rem; color: #fff; background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }
@media (prefers-color-scheme: dark) { button { color: #1c1c1e; } }
button:disabled { opacity: .5; cursor: default; }
ul { padding-left: 1.2rem; overflow-wrap: anywhere; }
progress { vertical-align: middle; width: 8rem; }
`

var sharePageTmpl = template.Must(template.New("share").Parse(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>{{.Title}}</title>
<style>` + sharePageCSS + `</style>
<main>
<h1>{{.Heading}}</h1>
{{with .Meta}}<p class="meta">{{.}}</p>{{end}}
{{range .Notes}}<p>{{.}}</p>{{end}}
{{with .Error}}<p class="error">{{.}}</p>{{end}}
{{with .Folder}}<p>Or if you meant the folder “{{.}}” in Downloads: <a href="{{$.FolderURL}}">open it there</a>.</p>{{end}}
{{if .Download}}<form method="post"><button type="submit">Download</button></form>{{end}}
{{if .Upload}}<form class="upload" method="post" enctype="multipart/form-data">
<input type="file" name="file" multiple required aria-label="Files to upload"><button type="submit">Upload</button></form>
{{end}}{{if or .Upload .Sent}}<ul id="sent">{{range .Sent}}<li{{if .Error}} class="error"{{end}}>{{.Text}}</li>{{end}}</ul>{{end}}
<p class="small">Shared with a TabTop link.</p>
</main>
{{if .Upload}}<script>` + uploadScript + `</script>{{end}}
`))

// sharePage is what a page shows.
type sharePage struct {
	Title, Heading, Meta, Error string
	// A link not found, which could be a folder's name in Downloads (as
	// /fs/<folder>/ looks like a link): the folder's name, and the files
	// page's address for it.
	Folder, FolderURL string
	Notes             []string
	Download, Upload  bool
	Sent              []sentLine
}

type sentLine struct {
	Text  string
	Error bool
}

// renderSharePage writes p as the answer, with code.
func renderSharePage(w http.ResponseWriter, code int, p sharePage) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", sharePageCSP)
	h.Set("X-Frame-Options", "DENY")
	h.Del("Content-Disposition")
	if p.Title == "" {
		p.Title = p.Heading
	}
	w.WriteHeader(code)
	if err := sharePageTmpl.Execute(w, p); err != nil {
		log.Printf("rendering a share link's page: %v", err)
	}
}

// shareFail answers with code and message: a page, if one was asked for,
// else plain text, as wget and curl show it.
func shareFail(w http.ResponseWriter, page bool, code int, message string) {
	if page {
		renderSharePage(w, code, sharePage{Title: "Link not available", Heading: "This link can't be used", Error: message})
		return
	}
	http.Error(w, message, code)
}

// timeLeft says how long is left until t, roughly.
func timeLeft(now, t time.Time) string {
	d := t.Sub(now)
	plural := func(n int, unit string) string {
		if n == 1 {
			return "1 " + unit
		}
		return fmt.Sprintf("%d %ss", n, unit)
	}
	switch {
	case d < time.Minute:
		return "less than a minute"
	case d < time.Hour:
		return plural(int(d/time.Minute), "minute")
	case d < 48*time.Hour:
		return plural(int(d/time.Hour), "hour")
	}
	return plural(int(d/(24*time.Hour)), "day")
}

// downloadPage is the page a download link shows a browser, as l is now.
func (g *server) downloadPage(l *shareLink, size int64) sharePage {
	p := sharePage{Heading: l.name(), Download: true}
	if l.Dir {
		p.Heading += ".zip"
		p.Meta = "A .zip of the folder " + l.name() + ", made when it's downloaded"
	} else {
		p.Meta = humanSize(size)
	}
	n := g.shares.now(l)
	note := "This link works for another " + timeLeft(g.shares.clock.Now(), n.Expires)
	if n.Max > 0 {
		left := max(0, n.Max-n.Count)
		note += fmt.Sprintf(", for %d more download%s", left, map[bool]string{true: "", false: "s"}[left == 1])
	}
	p.Notes = []string{note + "."}
	return p
}
