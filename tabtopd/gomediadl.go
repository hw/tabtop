// Media from a server without byte ranges, for the remote browser's
// players (go-media.js reads a file in parts). A server that answers a
// part with the whole file (200 OK, not 206) was refused; now the file is
// downloaded once, through the server, in order, to a temporary file, and
// its parts answered from what's come: at once if they have, else when
// they do. A part past what's come waits (seeking ahead, say); a file whose
// size the server doesn't say waits whole before its first part (a player
// needs its size). Ranges stay the way when a server has them.
//
// Bounded: goMediaDownloadMax a file, goMediaDownloadsPer a session at
// once, goMediaDownloadsMax in all; forgotten (and its file removed) after
// goMediaDownloadIdle unused.

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"
)

const (
	goMediaDownloadMax   = 512 << 20
	goMediaDownloadsPer  = 2
	goMediaDownloadsMax  = 8
	goMediaDownloadIdle  = 10 * time.Minute
	goMediaDownloadStart = 30 * time.Second // to the server's answer
	goMediaDownloadWait  = 60 * time.Second // for a part not come yet
)

// errMediaNoRanges is what fetchRemoteResource says of a server that sent
// the whole file for a part (previews say it; the remote browser
// downloads it instead).
var errMediaNoRanges = errors.New("Media streaming requires a server with byte-range support.")

type goMediaDownload struct {
	key          string // in goMediaDownloads (goMediaKey)
	session, url string
	mu           sync.Mutex
	changed      chan struct{} // closed, and replaced, as more comes
	file         *os.File
	have         int64
	total        int64 // -1 till it's known
	done         bool
	err          error
	mime         string
	validator    string
	final        string // where it was, after redirects
	idle         *time.Timer
	cancel       context.CancelFunc
}

var goMediaDownloads = struct {
	sync.Mutex
	by map[string]*goMediaDownload
}{by: map[string]*goMediaDownload{}}

// goFetchMedia answers a part of a page's media: by a range, as before; or,
// from a server that has none, from its download.
func goFetchMedia(ctx context.Context, session string, req tunnelRequest, client *http.Client, slots *previewWork, userAgent string, from *goFrom) ([]byte, map[string]any, error) {
	client = from.client(client) // (the tab's certificate exceptions: gocert.go)
	if u, err := url.Parse(req.URL); err == nil && from.adBlocked(u, "media") {
		return nil, nil, errors.New(goRefusals["ads"])
	}
	key := goMediaKey(session, req.URL, from)
	goMediaDownloads.Lock()
	d := goMediaDownloads.by[key]
	goMediaDownloads.Unlock()
	if d == nil {
		data, reply, err := fetchRemoteResource(ctx, req, client, slots, userAgent, from)
		if !errors.Is(err, errMediaNoRanges) {
			return data, reply, err
		}
		if d, err = goStartMediaDownload(session, req.URL, client, userAgent, from); err != nil {
			return nil, nil, err
		}
	}
	return d.part(ctx, req)
}

// goMediaKey is what a download of u is kept by: its login's session, and
// a tab's own, if the tab has certificate exceptions (its downloads are
// made with them: gocert.go, not another tab's to have); and whether it's
// for a private tab, whose cookies aren't the others' (goincognito.go).
func goMediaKey(session, u string, from *goFrom) string {
	key := session + "\x00" + u
	if from != nil && from.private {
		key += "\x00private"
	}
	if from != nil && from.certs.any() {
		key += fmt.Sprintf("\x00%p", from.certs)
	}
	return key
}

// goStartMediaDownload starts downloading u for session (or finds it
// started meanwhile).
func goStartMediaDownload(session, u string, client *http.Client, userAgent string, from *goFrom) (*goMediaDownload, error) {
	client = from.client(client) // (the tab's certificate exceptions: gocert.go)
	key := goMediaKey(session, u, from)
	goMediaDownloads.Lock()
	if d := goMediaDownloads.by[key]; d != nil {
		goMediaDownloads.Unlock()
		return d, nil
	}
	mine := 0
	for _, d := range goMediaDownloads.by {
		if d.session == session {
			mine++
		}
	}
	if mine >= goMediaDownloadsPer || len(goMediaDownloads.by) >= goMediaDownloadsMax {
		goMediaDownloads.Unlock()
		return nil, errors.New("This video's server can't send it in parts, and too many such videos are downloading; close one and try again.")
	}
	file, err := os.CreateTemp("", "tabtop-go-media-*")
	if err != nil {
		goMediaDownloads.Unlock()
		return nil, errors.New("This video's server can't send it in parts, and it couldn't be downloaded here.")
	}
	os.Remove(file.Name()) // gone once it's closed, whatever happens
	ctx, cancel := context.WithCancel(context.Background())
	d := &goMediaDownload{key: key, session: session, url: u, changed: make(chan struct{}), file: file, total: -1, cancel: cancel}
	d.idle = time.AfterFunc(goMediaDownloadIdle, d.forget)
	goMediaDownloads.by[key] = d
	goMediaDownloads.Unlock()
	go d.run(ctx, client, userAgent, from)
	return d, nil
}

func (d *goMediaDownload) run(ctx context.Context, client *http.Client, userAgent string, from *goFrom) {
	fail := func(err error) {
		d.mu.Lock()
		d.err, d.done = err, true
		close(d.changed)
		d.changed = make(chan struct{})
		d.mu.Unlock()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, d.url, nil)
	if err != nil {
		fail(errors.New("Invalid media address."))
		return
	}
	request.Header.Set("Accept-Encoding", "identity")
	if userAgent != "" {
		request.Header.Set("User-Agent", userAgent)
	}
	from.apply(request)
	c := *client
	redirects := c.CheckRedirect
	c.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if redirects != nil {
			if err := redirects(next, via); err != nil {
				return err
			}
		}
		if goBlockedHost(next.URL.Hostname()) || from.adBlocked(next.URL, "media") {
			return http.ErrUseLastResponse
		}
		from.apply(next)
		return nil
	}
	// Only the answer is held to goMediaDownloadStart; the file, as long as
	// it takes (each part's wait says when that's too long).
	late := time.AfterFunc(goMediaDownloadStart, d.cancel)
	response, err := c.Do(request)
	if !late.Stop() {
		err = errors.New("The video's server didn't answer.")
	}
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		fail(fetchError(err))
		return
	}
	defer response.Body.Close()
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	switch media {
	case "audio/x-wav", "audio/wave":
		media = "audio/wav"
	case "audio/mp3":
		media = "audio/mpeg"
	case "video/x-m4v":
		media = "video/mp4"
	}
	// Labelled only as bytes: what its first bytes say it is (sniffMedia).
	body := bufio.NewReaderSize(response.Body, mediaSniffLen)
	if goUnlabelled(media) && response.StatusCode == http.StatusOK {
		head, _ := body.Peek(mediaSniffLen)
		media = sniffMedia(head)
	}
	switch {
	case response.StatusCode != http.StatusOK:
		fail(errors.New("The media server returned HTTP " + strconv.Itoa(response.StatusCode) + "."))
		return
	case response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity":
		fail(errors.New("Encoded resources cannot be previewed safely."))
		return
	case !previewResourceType("media", media):
		fail(errors.New("The external resource has an unsupported content type."))
		return
	case response.ContentLength > goMediaDownloadMax:
		fail(errors.New("This video's server can't send it in parts, and it's too large to download here (over " + strconv.Itoa(goMediaDownloadMax>>20) + " MB)."))
		return
	}
	d.mu.Lock()
	d.mime, d.validator, d.final = media, previewValidator(response.Header), response.Request.URL.String()
	if response.ContentLength >= 0 {
		d.total = response.ContentLength
	}
	d.mu.Unlock()
	buf := make([]byte, 256<<10)
	limited := io.LimitReader(body, goMediaDownloadMax+1)
	for {
		n, rerr := limited.Read(buf)
		if n > 0 {
			if _, werr := d.file.WriteAt(buf[:n], d.have); werr != nil {
				fail(errors.New("The video couldn't be downloaded here."))
				return
			}
			d.mu.Lock()
			d.have += int64(n)
			over := d.have > goMediaDownloadMax
			close(d.changed)
			d.changed = make(chan struct{})
			d.mu.Unlock()
			if over {
				fail(errors.New("This video's server can't send it in parts, and it's too large to download here."))
				return
			}
		}
		if rerr == io.EOF {
			d.mu.Lock()
			if d.total < 0 {
				d.total = d.have
			}
			if d.have != d.total {
				d.err = errors.New("The video's download ended early.")
			}
			d.done = true
			close(d.changed)
			d.changed = make(chan struct{})
			d.mu.Unlock()
			return
		}
		if rerr != nil {
			if ctx.Err() == nil {
				log.Printf("go: media download: %v", rerr)
			}
			fail(errors.New("The video's download broke off."))
			return
		}
	}
}

// part answers req's range from the download: once it's come (or the
// download's ended), waiting at most goMediaDownloadWait.
func (d *goMediaDownload) part(ctx context.Context, req tunnelRequest) ([]byte, map[string]any, error) {
	d.idle.Reset(goMediaDownloadIdle)
	begin, length := req.Offset, req.Length
	probe := length == 0
	if probe {
		begin, length = 0, 1
	}
	if begin < 0 || length < 1 || length > maxPreviewMediaRange {
		return nil, nil, errors.New("Invalid media range.")
	}
	wait, cancel := context.WithTimeout(ctx, goMediaDownloadWait)
	defer cancel()
	for {
		d.mu.Lock()
		ready := d.done || d.have >= begin+length && (d.total >= 0 || !probe)
		changed, err := d.changed, d.err
		d.mu.Unlock()
		if err != nil {
			return nil, nil, err
		}
		if ready {
			break
		}
		select {
		case <-changed:
		case <-wait.Done():
			if ctx.Err() != nil {
				return nil, nil, ctx.Err()
			}
			return nil, nil, errors.New("This part of the video hasn't downloaded yet; try again in a moment.")
		}
	}
	d.mu.Lock()
	total, validator, media, final, have := d.total, d.validator, d.mime, d.final, d.have
	d.mu.Unlock()
	if !probe && (total != req.IfSize || req.IfMtime != "" && validator != req.IfMtime) {
		return nil, nil, errors.New("The remote media changed; reopen the preview.")
	}
	if begin+length > have {
		return nil, nil, errors.New("The media range ended early.")
	}
	data := make([]byte, length)
	if _, err := d.file.ReadAt(data, begin); err != nil {
		return nil, nil, errors.New("The video couldn't be read here.")
	}
	return data, map[string]any{"size": len(data), "mime": media, "url": final, "total_size": total, "validator": validator}, nil
}

// forget stops the download, if it's still going, and drops its file.
func (d *goMediaDownload) forget() {
	goMediaDownloads.Lock()
	if goMediaDownloads.by[d.key] == d {
		delete(goMediaDownloads.by, d.key)
	}
	goMediaDownloads.Unlock()
	d.cancel()
	d.mu.Lock()
	d.file.Close()
	d.mu.Unlock()
}

// serveGoMedia answers a go-resource request for media on a tunnel of its
// own, as serveRemoteResource does, by goFetchMedia.
func serveGoMedia(t *tunnel, session string, req tunnelRequest, r *tunnelResponder, client *http.Client, slots *previewWork, userAgent string, from *goFrom) {
	client = from.client(client) // (the tab's certificate exceptions: gocert.go)
	w := newChunkWriter(t)
	defer w.stop()
	data, reply, err := goFetchMedia(w.ctx, session, req, client, slots, userAgent, from)
	if err != nil {
		if w.ctx.Err() == nil {
			r.fail(err.Error())
		}
		return
	}
	if !r.accept(reply) {
		return
	}
	if _, err := w.Write(data); err != nil {
		w.fail(err)
		return
	}
	if w.flush() == nil {
		r.finish(nil)
	}
}
