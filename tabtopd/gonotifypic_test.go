package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/png"
	"strings"
	"testing"
)

func goTestPNG(t *testing.T) []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestGoNotifyPicture: a notification's picture given as a data: address of
// its type only if it's a raster picture within its size; an SVG, a page,
// or one too large, not.
func TestGoNotifyPicture(t *testing.T) {
	b, _ := goClipTab()
	pic := goTestPNG(t)
	data := func(mime string, d []byte) string {
		return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(d)
	}
	ctx := context.Background()
	if got := b.notifyPicture(ctx, data("image/png", pic), 1<<20); !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Errorf("a PNG: %.40q", got)
	}
	// Labelled as anything: what it is counts.
	if got := b.notifyPicture(ctx, data("text/plain", pic), 1<<20); !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Errorf("a PNG labelled text: %.40q", got)
	}
	for name, raw := range map[string]string{
		"an SVG":       data("image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)),
		"a page":       data("image/png", []byte("<!doctype html><p>hi")),
		"too large":    data("image/png", append(pic, make([]byte, 2<<20)...)),
		"not base64":   "data:image/png,abc",
		"another kind": "ftp://example.com/x.png",
	} {
		if got := b.notifyPicture(ctx, raw, 1<<20); got != "" {
			t.Errorf("%s given: %.40q", name, got)
		}
	}
}
