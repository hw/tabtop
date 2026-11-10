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

// Each reservation includes all buffering and flow-controlled writes.
var previewResourceSlots = make(chan struct{}, 4)

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
func (g *server) tunnelPreviewResource(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	if g.fetches == nil || g.fetches.resourceClient == nil {
		r.fail("External resource proxying is turned off (WEB_FETCH=0).")
		return
	}
	limit := previewResourceLimit(req.Resource)
	if limit == 0 {
		r.fail("Unsupported preview resource type.")
		return
	}
	u, err := url.Parse(req.URL)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		r.fail("Give an HTTP or HTTPS resource URL without credentials.")
		return
	}
	begin, length := req.Offset, req.Length
	probe := req.Resource == "media" && length == 0
	if probe {
		begin, length = 0, 1
	}
	if req.Resource == "media" && (begin < 0 || length < 1 || length > maxPreviewMediaRange || begin > 1<<53-1-length || (!probe && (req.IfSize < begin+length || req.IfSize > 1<<53-1))) {
		r.fail("Invalid media range.")
		return
	}
	select {
	case previewResourceSlots <- struct{}{}:
		defer func() { <-previewResourceSlots }()
	default:
		r.fail("Too many external resources are loading; try again.")
		return
	}
	w := newChunkWriter(t)
	defer w.stop()
	ctx, cancel := context.WithTimeout(w.ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		r.fail("Invalid resource URL.")
		return
	}
	request.Header.Set("Accept-Encoding", "identity")
	if req.Resource == "media" {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", begin, begin+length-1))
		if req.IfMtime != "" {
			request.Header.Set("If-Range", req.IfMtime)
		}
	}
	client := *g.fetches.resourceClient
	redirects := client.CheckRedirect
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if next.URL.User != nil {
			return http.ErrUseLastResponse
		}
		if redirects != nil {
			return redirects(next, via)
		}
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		r.fail(fetchError(err).Error())
		return
	}
	defer response.Body.Close()
	if encoded := response.Header.Get("Content-Encoding"); encoded != "" && encoded != "identity" {
		r.fail("Encoded resources cannot be previewed safely.")
		return
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
		r.fail("The external resource has an unsupported content type.")
		return
	}
	var total int64
	validator := previewValidator(response.Header)
	if req.Resource == "media" {
		if response.StatusCode != http.StatusPartialContent {
			r.fail("Media streaming requires a server with byte-range support.")
			return
		}
		total, err = previewContentRange(response.Header.Get("Content-Range"), begin, begin+length)
		if err != nil || total > 1<<53-1 {
			r.fail("The media server returned an invalid byte range.")
			return
		}
		if !probe && (total != req.IfSize || req.IfMtime != "" && validator != req.IfMtime) {
			r.fail("The remote media changed; reopen the preview.")
			return
		}
		limit = length
	} else if response.StatusCode != http.StatusOK {
		r.fail("The external resource did not return HTTP 200.")
		return
	}
	if response.ContentLength > limit {
		r.fail("External resource exceeds the preview limit (" + strconv.FormatInt(limit, 10) + " bytes).")
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		r.fail("The external resource could not be read.")
		return
	}
	if int64(len(data)) > limit {
		r.fail("External resource exceeds the preview limit.")
		return
	}
	if req.Resource == "font" && !previewFont(data) {
		r.fail("The resource is not a supported font.")
		return
	}
	if req.Resource == "media" && int64(len(data)) != length {
		r.fail("The media range ended early.")
		return
	}
	reply := map[string]any{"size": len(data), "mime": media, "url": response.Request.URL.String()}
	if req.Resource == "media" {
		reply["total_size"] = total
		reply["validator"] = validator
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
