package main

// HEIC (and HEIF) pictures, which most browsers can't show: decoded here,
// with libheif (see heif_decode.go), to a JPEG (a PNG where the picture has
// transparency) the page shows in their place. The file itself is what's
// downloaded, and what its EXIF is read from and written to (in the page:
// image-heif.js); only what's shown is made here.
//
// libheif runs in a child of tabtopd's own (see isolated_child.go), on the
// file as it was opened, given as its input, in a sandbox (heif_sandbox.go:
// no files opened, no network, no programs run), with limits on its memory
// and processor time: a picture that's malformed, or made to be, can end
// that child, and one that took over its decoder could do little else.
// libheif's own limits are tightened (no larger than the picture editor
// takes, nor more memory than that needs), and the child has a time limit
// and a cap on what it writes.
import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net"
	"os"
	"syscall"
	"time"
)

const (
	heifChildArg = "--heif-child"
	// What's read of a HEIF file, at most; what's written for one, at most.
	maxHEIFInput  = 200 << 20
	maxHEIFOutput = 96 << 20
	// The largest picture decoded (as image-view.js's MAX_EDIT_PIXELS).
	maxHEIFPixels = 100_000_000
	heifTimeout   = 60 * time.Second
	heifQuality   = 90
	// A thumbnail asked for: the file's own if it's at least this on its
	// longer side (thumbnails.js makes them 192); if it hasn't one, the
	// picture itself, if it's no more than maxHEIFThumbnailPixels.
	heifThumbnailSide      = 192
	maxHEIFThumbnailPixels = 64_000_000
	// What the child may have of memory (libheif's own limit, 3 GiB, and
	// more), and of the processor's time (more than heifTimeout: as well).
	heifChildMemory = 4 << 30
	heifChildCPU    = 90
)

var (
	heifSlots = newPreviewWork(previewReadConcurrency)
	// errHEIFUnsupported is a tabtopd built without libheif's.
	errHEIFUnsupported = errors.New("This server can't show HEIC pictures: it was built without libheif.")
	// heifDecoder is what "image-decode" decodes with (tests put another).
	heifDecoder = decodeHEIFIsolated
)

// heifPicture is a picture libheif decoded: its pixels, and whether any
// isn't opaque (so it's written as a PNG, not a JPEG).
type heifPicture struct {
	image *image.NRGBA
	alpha bool
}

// readHEIFChild is the child: the HEIF file on its input, the picture on its
// output, as a JPEG or a PNG; or why not, and exit 1. It decodes in a
// sandbox (see heif_sandbox.go), with limits on its memory (all of it, C's
// too, not only Go's) and processor time. With the argument
// "sandbox-check", it says what the sandbox lets it do (for its test).
func readHEIFChild(args []string) int {
	fail := func(err error) int {
		os.Stdout.WriteString(err.Error())
		return 1
	}
	syscall.Setrlimit(syscall.RLIMIT_DATA, &syscall.Rlimit{Cur: heifChildMemory, Max: heifChildMemory})
	syscall.Setrlimit(syscall.RLIMIT_CPU, &syscall.Rlimit{Cur: heifChildCPU, Max: heifChildCPU})
	sandboxed := heifPrepare()
	if len(args) == 1 && args[0] == "sandbox-check" {
		_, open := os.Open("/etc/hostname")
		_, dial := net.Dial("tcp", "127.0.0.1:9")
		fmt.Printf("sandbox: %v; open: %v; dial: %v", sandboxed, open, dial)
		return 0
	}
	thumbnail := len(args) == 1 && args[0] == "thumbnail"
	data, err := io.ReadAll(io.LimitReader(os.Stdin, maxHEIFInput+1))
	if err != nil {
		return fail(errors.New("The picture couldn't be read."))
	}
	if len(data) > maxHEIFInput {
		return fail(errors.New("The picture is too large to show."))
	}
	pic, err := decodeHEIF(data, thumbnail)
	if err != nil {
		return fail(err)
	}
	data = nil
	var out bytes.Buffer
	if pic.alpha {
		err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&out, pic.image)
	} else {
		err = jpeg.Encode(&out, pic.image, &jpeg.Options{Quality: heifQuality})
	}
	if err != nil {
		return fail(errors.New("The picture couldn't be written."))
	}
	os.Stdout.Write(out.Bytes())
	return 0
}

// decodeHEIFIsolated is the picture in f, decoded by the child: its bytes,
// and their type.
func decodeHEIFIsolated(ctx context.Context, f *os.File, thumbnail bool) ([]byte, string, error) {
	release, ok := heifSlots.acquireContext(ctx)
	if !ok && ctx.Err() != nil {
		return nil, "", ctx.Err()
	} else if !ok {
		return nil, "", errors.New("Other pictures are being decoded; try again in a moment.")
	}
	defer release()
	args := []string{heifChildArg}
	if thumbnail {
		args = append(args, "thumbnail")
	}
	result := runIsolatedChild(isolatedChild{Context: ctx, Args: args, Input: f, Timeout: heifTimeout, OutputLimit: maxHEIFOutput})
	switch {
	case ctx.Err() != nil:
		return nil, "", ctx.Err()
	case result.TimedOut:
		return nil, "", errors.New("Decoding the picture took too long, so it was stopped.")
	case result.Overflow:
		return nil, "", errors.New("The picture is too large to show.")
	case result.Err != nil && result.ExitCode == 1 && len(result.Output) < 500:
		return nil, "", errors.New(string(result.Output))
	case result.Err != nil:
		return nil, "", errors.New("The picture couldn't be decoded.")
	}
	if bytes.HasPrefix(result.Output, []byte("\x89PNG")) {
		return result.Output, "image/png", nil
	}
	return result.Output, "image/jpeg", nil
}

// tunnelImageDecode answers an "image-decode" request: the HEIF picture at
// req.Path (of the version req.IfMtime says, if it says), as a JPEG or a
// PNG; sent as "file" sends a file's bytes, with its type.
func (g *fileService) tunnelImageDecode(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	opened, err := g.openFile(req.Path)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer opened.Close()
	st := opened.info
	if req.changedSinceRead(st) {
		r.fail(errChangedSince.Error())
		return
	}
	if st.Size() > maxHEIFInput {
		r.fail("The picture is too large to show.")
		return
	}
	// The writer is made first: its reader of the page's acknowledgements
	// is the tunnel's only one, and how the page giving up (the preview
	// closed) is noticed, killing the child. (Another reader, CloseRead's,
	// would take acknowledgements out of turn, and break the tunnel once a
	// picture is more than the page's window.)
	w := newChunkWriter(t)
	defer w.stop()
	out, typ, err := heifDecoder(w.ctx, opened.file, req.Thumbnail)
	if w.ctx.Err() != nil {
		return
	}
	if err != nil {
		r.fail(err.Error())
		return
	}
	n := int64(len(out))
	if !r.accept(map[string]any{"name": st.Name(), "size": st.Size(), "mtime": fileVersion(st), "type": typ, "length": n}) {
		return
	}
	if _, err := w.Write(out); err != nil {
		w.fail(err)
		return
	}
	if w.flush() == nil {
		r.finish(nil)
	}
}
