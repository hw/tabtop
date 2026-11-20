package main

// Media a server labels only as bytes (binary/octet-stream, as some CDNs
// say of everything): recognised by its first bytes, as a browser does, and
// taken as what they are, if it's audio or video a player here plays; else
// refused, as before. Its first bytes are asked for once (a probe asks for
// one), and what they were remembered by address and version.

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"sync"
)

// mediaSniffLen is how much of a file is looked at.
const mediaSniffLen = 512

// sniffMedia is the media type data (a file's first bytes) is, if it's
// one a player here plays, else "".
func sniffMedia(b []byte) string {
	switch {
	case len(b) >= 12 && string(b[4:8]) == "ftyp":
		switch string(b[8:12]) {
		case "qt  ":
			return "video/quicktime"
		case "M4A ", "M4B ", "M4P ", "F4A ":
			return "audio/mp4"
		}
		return "video/mp4"
	case bytes.HasPrefix(b, []byte{0x1a, 0x45, 0xdf, 0xa3}): // EBML: Matroska, or WebM
		if bytes.Contains(b[:min(len(b), 64)], []byte("webm")) {
			return "video/webm"
		}
		return "video/x-matroska"
	case bytes.HasPrefix(b, []byte("OggS")):
		if bytes.Contains(b, []byte("theora")) {
			return "video/ogg"
		}
		return "audio/ogg"
	case bytes.HasPrefix(b, []byte("fLaC")):
		return "audio/flac"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WAVE":
		return "audio/wav"
	case bytes.HasPrefix(b, []byte("ID3")):
		return "audio/mpeg"
	case len(b) >= 2 && b[0] == 0xff && b[1]&0xf6 == 0xf0: // ADTS: AAC
		return "audio/aac"
	case len(b) >= 2 && b[0] == 0xff && b[1]&0xe0 == 0xe0 && b[1]&0x06 != 0: // an MPEG audio frame
		return "audio/mpeg"
	}
	return ""
}

// mediaSniffed is what unlabelled media was found to be, by its address
// and version (validator); a few hundred remembered.
var mediaSniffed = struct {
	sync.Mutex
	by map[string]string
}{by: map[string]string{}}

// sniffRemoteMedia is the media type of the file at u (labelled only as
// bytes), by its first bytes, asked for through client as userAgent, with
// what the page's browser would send to u itself (from: u's own cookies
// and Referer, never another address's); "" if it's none a player here
// plays.
func sniffRemoteMedia(ctx context.Context, client *http.Client, u, validator, userAgent string, from *goFrom) string {
	key := u + "\x00" + validator
	mediaSniffed.Lock()
	media, ok := mediaSniffed.by[key]
	mediaSniffed.Unlock()
	if ok {
		return media
	}
	first, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return ""
	}
	first.Header.Set("Accept-Encoding", "identity")
	if userAgent != "" {
		first.Header.Set("User-Agent", userAgent)
	}
	from.apply(first) // (and anew at each redirect: client's CheckRedirect)
	first.Header.Set("Range", fmt.Sprintf("bytes=0-%d", mediaSniffLen-1))
	response, err := client.Do(first)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		return ""
	}
	if enc := response.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		return ""
	}
	head, _ := io.ReadAll(io.LimitReader(response.Body, mediaSniffLen))
	media = sniffMedia(head)
	mediaSniffed.Lock()
	if len(mediaSniffed.by) >= 256 {
		for k := range mediaSniffed.by {
			delete(mediaSniffed.by, k)
			break
		}
	}
	mediaSniffed.by[key] = media
	mediaSniffed.Unlock()
	return media
}
