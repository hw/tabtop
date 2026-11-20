package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	maxPreviewResource   = 20 << 20
	maxPreviewCSS        = 512 << 10
	maxPreviewFont       = 8 << 20
	maxPreviewMediaRange = 1 << 20
)

// Each reservation includes all buffering and flow-controlled writes. A
// request waits a while for one (a video's range reads come several at a
// time, and pictures alongside them) rather than failing at once.
var previewResourceSlots = newBoundedWork(4, 15*time.Second)

func previewResourceLimit(kind string) int64 {
	switch kind {
	case "", "image":
		return maxPreviewResource
	case "css":
		return maxPreviewCSS
	case "font":
		return maxPreviewFont
	case "media":
		return maxPreviewMediaRange
	}
	return 0
}
func previewResourceType(kind, media string) bool {
	switch kind {
	case "", "image":
		return strings.HasPrefix(media, "image/")
	case "css":
		return media == "text/css"
	case "font":
		return strings.HasPrefix(media, "font/") || (media == "application/font-woff" || media == "application/x-font-woff" || media == "application/font-sfnt" || media == "application/x-font-truetype") || media == "application/vnd.ms-fontobject" || media == "application/octet-stream" || media == "application/x-font-ttf" || media == "application/x-font-opentype"
	case "media":
		for _, ft := range fileTypes {
			if (ft.Kind == "audio" || ft.Kind == "video") && ft.MIME == media {
				return true
			}
		}
	}
	return false
}
func previewFont(data []byte) bool {
	if len(data) < 4 {
		return false
	}
	magic := string(data[:4])
	return magic == "wOFF" || magic == "wOF2" || magic == "OTTO" || magic == "ttcf" || magic == "\x00\x01\x00\x00"
}
func previewValidator(h http.Header) string {
	if tag := h.Get("ETag"); len(tag) >= 2 && len(tag) <= 512 && strings.HasPrefix(tag, `"`) && strings.HasSuffix(tag, `"`) {
		return tag
	}
	if modified := h.Get("Last-Modified"); modified != "" {
		if _, err := http.ParseTime(modified); err == nil {
			return modified
		}
	}
	return ""
}

// Range metadata is never trusted until its interval and total are validated.
func previewContentRange(value string, begin, end int64) (int64, error) {
	var first, last, total int64
	if n, err := fmt.Sscanf(value, "bytes %d-%d/%d", &first, &last, &total); err != nil || n != 3 ||
		value != fmt.Sprintf("bytes %d-%d/%d", first, last, total) || first != begin || last != end-1 || total <= last || first < 0 || last < first {
		return 0, errors.New("The media server returned an invalid byte range.")
	}
	return total, nil
}

// Remote resources are never saved and never receive browser credentials.
func (g *fileService) tunnelPreviewResource(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	if g.resourceClient == nil {
		r.fail("External resource proxying is turned off (WEB_GO_FETCH=0).")
		return
	}
	serveRemoteResource(t, req, r, g.resourceClient, previewResourceSlots, "", nil)
}

// serveRemoteResource answers req, fetched with client, a slot of slots
// held, as userAgent if it's set, with cookies' if they're given: a
// preview's resource, or (in byte ranges, "media") the audio and video a
// preview or the remote browser plays.
func serveRemoteResource(t *tunnel, req tunnelRequest, r *tunnelResponder, client *http.Client, slots *previewWork, userAgent string, cookies func(*url.URL) string) {
	w := newChunkWriter(t)
	defer w.stop()
	data, reply, err := fetchRemoteResource(w.ctx, req, client, slots, userAgent, cookies)
	if err != nil {
		if w.ctx.Err() == nil { // not the page that stopped waiting
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

// fetchRemoteResource fetches req's resource (in byte ranges, "media"),
// with client, a slot of slots held, as userAgent if it's set, until ctx
// ends: its bytes, and what's said of them (size, mime, url; and for media
// total_size and validator), or why not, said for the person. cookies, if
// given, is the Cookie header for an address (the remote browser's, for
// the site's media): asked again for each address redirected to.
func fetchRemoteResource(ctx context.Context, req tunnelRequest, client *http.Client, slots *previewWork, userAgent string, cookies func(*url.URL) string) ([]byte, map[string]any, error) {
	fail := func(message string) ([]byte, map[string]any, error) { return nil, nil, errors.New(message) }
	limit := previewResourceLimit(req.Resource)
	if limit == 0 {
		return fail("Unsupported preview resource type.")
	}
	u, err := url.Parse(req.URL)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return fail("Give an HTTP or HTTPS resource URL without credentials.")
	}
	begin, length := req.Offset, req.Length
	probe := req.Resource == "media" && length == 0
	if probe {
		begin, length = 0, 1
	}
	if req.Resource == "media" && (begin < 0 || length < 1 || length > maxPreviewMediaRange || begin > 1<<53-1-length || (!probe && (req.IfSize < begin+length || req.IfSize > 1<<53-1))) {
		return fail("Invalid media range.")
	}
	release, ok := slots.acquireContext(ctx)
	if !ok && ctx.Err() != nil {
		return nil, nil, ctx.Err() // the page stopped waiting
	} else if !ok {
		return fail("Too many external resources are loading; try again.")
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return fail("Invalid resource URL.")
	}
	request.Header.Set("Accept-Encoding", "identity")
	if userAgent != "" {
		request.Header.Set("User-Agent", userAgent)
	}
	setCookies := func(r *http.Request) {
		r.Header.Del("Cookie")
		if cookies != nil {
			if c := cookies(r.URL); c != "" {
				r.Header.Set("Cookie", c)
			}
		}
	}
	setCookies(request)
	if req.Resource == "media" {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", begin, begin+length-1))
		if req.IfMtime != "" {
			request.Header.Set("If-Range", req.IfMtime)
		}
	}
	c := *client
	redirects := c.CheckRedirect
	c.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if next.URL.User != nil {
			return http.ErrUseLastResponse
		}
		setCookies(next) // the new address's own, not the last one's
		if redirects != nil {
			return redirects(next, via)
		}
		return nil
	}
	response, err := c.Do(request)
	if err != nil {
		return nil, nil, fetchError(err)
	}
	defer response.Body.Close()
	if encoded := response.Header.Get("Content-Encoding"); encoded != "" && encoded != "identity" {
		return fail("Encoded resources cannot be previewed safely.")
	}
	if response.StatusCode >= 400 {
		// A refusal (often a page saying so), not a resource of any type.
		return fail("The site refused the resource (HTTP " + strconv.Itoa(response.StatusCode) + ").")
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	switch media {
	case "audio/x-wav", "audio/wave":
		media = "audio/wav"
	case "audio/mp3":
		media = "audio/mpeg"
	case "video/x-m4v":
		media = "video/mp4"
	}
	if !previewResourceType(req.Resource, media) {
		return fail("The external resource has an unsupported content type.")
	}
	var total int64
	validator := previewValidator(response.Header)
	if req.Resource == "media" {
		// A whole body for a later part, asked for If-Range: the media's
		// changed since it was opened (the validator no longer matches).
		if response.StatusCode == http.StatusOK && !probe && req.IfMtime != "" && validator != req.IfMtime {
			return fail("The remote media changed; reopen the preview.")
		}
		if response.StatusCode != http.StatusPartialContent {
			return fail("Media streaming requires a server with byte-range support.")
		}
		total, err = previewContentRange(response.Header.Get("Content-Range"), begin, begin+length)
		if err != nil || total > 1<<53-1 {
			return fail("The media server returned an invalid byte range.")
		}
		if !probe && (total != req.IfSize || req.IfMtime != "" && validator != req.IfMtime) {
			return fail("The remote media changed; reopen the preview.")
		}
		limit = length
	} else if response.StatusCode != http.StatusOK {
		return fail("The external resource did not return HTTP 200.")
	}
	if response.ContentLength > limit {
		return fail("External resource exceeds the preview limit (" + strconv.FormatInt(limit, 10) + " bytes).")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return fail("The external resource could not be read.")
	}
	if int64(len(data)) > limit {
		return fail("External resource exceeds the preview limit.")
	}
	if req.Resource == "font" && !previewFont(data) {
		return fail("The resource is not a supported font.")
	}
	if req.Resource == "media" && int64(len(data)) != length {
		return fail("The media range ended early.")
	}
	reply := map[string]any{"size": len(data), "mime": media, "url": response.Request.URL.String()}
	if req.Resource == "media" {
		reply["total_size"] = total
		reply["validator"] = validator
	}
	return data, reply, nil
}
