package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestHEIFDecode: a HEIC picture decoded in the child, as the page is sent
// it: turned as the file says, a JPEG; one with transparency, a PNG; the
// file's own thumbnail when one is asked for and it's big enough; what
// isn't one, an error. Built without libheif (no -tags heif), it's said to
// be unsupported.
func TestHEIFDecode(t *testing.T) {
	decode := func(name string, thumbnail bool) (image.Image, string, error) {
		f, err := os.Open("testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		out, typ, err := decodeHEIFIsolated(context.Background(), f, thumbnail)
		if err != nil {
			return nil, "", err
		}
		img, format, err := image.Decode(bytes.NewReader(out))
		if err != nil {
			t.Fatalf("%s: what was sent isn't a picture: %v", name, err)
		}
		if "image/"+format != typ {
			t.Errorf("%s: said to be %s, but is %s", name, typ, format)
		}
		return img, typ, nil
	}
	if _, err := decodeHEIF([]byte{1}, false); err == errHEIFUnsupported {
		_, _, err := decode("rotated.heic", false)
		if err == nil || !strings.Contains(err.Error(), "built without libheif") {
			t.Fatalf("without libheif: %v", err)
		}
		t.Skip("built without -tags heif: decoding isn't tried")
	}
	// 160×120, turned a quarter (its irot): 120×160, as browsers would show it.
	img, typ, err := decode("rotated.heic", false)
	if err != nil || typ != "image/jpeg" || img.Bounds().Dx() != 120 || img.Bounds().Dy() != 160 {
		t.Errorf("rotated.heic: %v, %s, %v", err, typ, img.Bounds())
	}
	// Half see-through on its left: a PNG, with that alpha.
	img, typ, err = decode("alpha.heic", false)
	if err != nil || typ != "image/png" {
		t.Fatalf("alpha.heic: %v, %s", err, typ)
	}
	if _, _, _, a := img.At(4, 4).RGBA(); a == 0xffff || a == 0 {
		t.Errorf("alpha.heic: alpha %d where it's half see-through", a)
	}
	if _, _, _, a := img.At(40, 4).RGBA(); a != 0xffff {
		t.Errorf("alpha.heic: alpha %d where it's opaque", a)
	}
	// 640×480, with a 256×192 thumbnail of its own: that, when a thumbnail will do.
	full, _, _ := decode("thumbed.heic", false)
	small, _, err := decode("thumbed.heic", true)
	if err != nil || full.Bounds().Dx() != 640 || small.Bounds().Dx() != 256 {
		t.Errorf("thumbed.heic: %v, %v, %v", err, full.Bounds(), small.Bounds())
	}
	// One with no thumbnail of its own: the picture itself.
	if img, _, err := decode("rotated.heic", true); err != nil || img.Bounds().Dx() != 120 {
		t.Errorf("rotated.heic as a thumbnail: %v", err)
	}
	// Not a picture; a picture cut short: an error, said.
	for _, name := range []string{"tunnel_interop.mjs"} {
		if _, _, err := decode(name, false); err == nil || !strings.Contains(err.Error(), "couldn't be decoded") {
			t.Errorf("%s: %v", name, err)
		}
	}
	whole, _ := os.ReadFile("testdata/rotated.heic")
	cut, _ := os.CreateTemp(t.TempDir(), "cut")
	cut.Write(whole[:len(whole)/2])
	cut.Seek(0, 0)
	if _, _, err := decodeHEIFIsolated(context.Background(), cut, false); err == nil {
		t.Error("half a HEIC file decoded")
	}
	cut.Close()
}

// TestTunnelImageDecode: a decoded picture bigger than the page's window
// of chunks comes whole, acknowledged as it comes, as any file does; and
// one the page gives up on while it's decoded is stopped.
func TestTunnelImageDecode(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	if err := os.WriteFile(filepath.Join(g.downloadsDir, "photo.heic"), []byte("not decoded here"), 0o644); err != nil {
		t.Fatal(err)
	}
	picture := make([]byte, (fileWindow+3)*fileChunk+17)
	rand.Read(picture)
	stopped := make(chan struct{})
	heifDecoder = func(ctx context.Context, f *os.File, thumbnail bool) ([]byte, string, error) {
		if thumbnail {
			// Slow: until the page gives up.
			<-ctx.Done()
			close(stopped)
			return nil, "", ctx.Err()
		}
		return picture, "image/jpeg", nil
	}
	t.Cleanup(func() { heifDecoder = decodeHEIFIsolated })
	s := login(t, ctx, srv.URL, code(0))

	c := openSession(t, ctx, srv.URL, s)
	reply := c.request(t, ctx, tunnelRequest{Type: "image-decode", Path: "photo.heic"})
	if reply["type"] != "image/jpeg" || reply["length"] != float64(len(picture)) {
		t.Fatalf("reply: %v", reply)
	}
	var got []byte
	for {
		kind, data, err := c.read(ctx)
		if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
			break
		}
		if err != nil || kind != msgData {
			t.Fatalf("after %d bytes: kind %d: %v", len(got), kind, err)
		}
		got = append(got, data...)
		if err := c.write(ctx, msgData, nil); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(got, picture) {
		t.Fatalf("got %d bytes, want %d", len(got), len(picture))
	}

	c = openSession(t, ctx, srv.URL, s)
	b, _ := json.Marshal(tunnelRequest{Type: "image-decode", Path: "photo.heic", Thumbnail: true})
	if err := c.write(ctx, msgText, b); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	c.c.CloseNow()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("decoding went on after the page went")
	}
}

// TestHEIFChildSandbox: the child, decoding, can't open a file nor reach
// the network (built with libheif; without, it decodes nothing, and has no
// sandbox to have).
func TestHEIFChildSandbox(t *testing.T) {
	if _, err := decodeHEIF([]byte{1}, false); err == errHEIFUnsupported {
		t.Skip("built without -tags heif")
	}
	result := runIsolatedChild(isolatedChild{Args: []string{heifChildArg, "sandbox-check"}, Input: strings.NewReader(""), Timeout: 30 * time.Second, OutputLimit: 4096})
	said := string(result.Output)
	if result.Err != nil || !strings.HasPrefix(said, "sandbox: <nil>;") {
		t.Fatalf("not sandboxed: %q, %v", said, result.Err)
	}
	if strings.Count(said, "operation not permitted") != 2 {
		t.Fatalf("a file opened, or the network reached: %q", said)
	}
}
