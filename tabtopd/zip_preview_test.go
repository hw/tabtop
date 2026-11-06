package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type zipCountingReader struct {
	*bytes.Reader
	read int
}

func (r *zipCountingReader) ReadAt(p []byte, off int64) (int, error) {
	n, err := r.Reader.ReadAt(p, off)
	r.read += n
	return n, err
}

func TestZipPreviewMetadataOnly(t *testing.T) {
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	for _, name := range []string{"folder/", "folder/readme.txt", "../outside", "<img src=x onerror=alert(1)>", "link"} {
		h := &zip.FileHeader{Name: name, Method: zip.Store}
		if name == "link" {
			h.SetMode(os.ModeSymlink | 0o777)
		}
		f, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if name == "folder/readme.txt" {
			f.Write(bytes.Repeat([]byte("a"), 2<<20))
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	data := out.Bytes()
	// Mark one entry encrypted in its central header; listing needs no key.
	at := bytes.Index(data, []byte("PK\x01\x02"))
	binary.LittleEndian.PutUint16(data[at+8:], 1)
	r := &zipCountingReader{Reader: bytes.NewReader(data)}
	entries, err := listZipPreview(r, int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 5 || entries[0].Kind != "Folder" || !entries[0].Encrypted || entries[1].Size != fmt.Sprint(2<<20) || entries[2].Name != "../outside" || entries[4].Kind != "Symlink" {
		t.Fatalf("entries: %+v", entries)
	}
	if r.read > 150000 {
		t.Fatalf("read %d bytes of %d; archive contents should not be read", r.read, len(data))
	}
}

func TestZipPreviewZIP64(t *testing.T) {
	name := []byte("large.bin")
	dir := make([]byte, 46+len(name)+20)
	put16 := binary.LittleEndian.PutUint16
	put32 := binary.LittleEndian.PutUint32
	put64 := binary.LittleEndian.PutUint64
	put32(dir, 0x02014b50)
	put16(dir[6:], 45)
	put32(dir[20:], 0xffffffff)
	put32(dir[24:], 0xffffffff)
	put16(dir[28:], uint16(len(name)))
	put16(dir[30:], 20)
	copy(dir[46:], name)
	extra := dir[46+len(name):]
	put16(extra, 1)
	put16(extra[2:], 16)
	put64(extra[4:], 1<<54+123)
	put64(extra[12:], 1<<53+4)
	record := make([]byte, 56)
	put32(record, 0x06064b50)
	put64(record[4:], 44)
	put64(record[24:], 1)
	put64(record[32:], 1)
	put64(record[40:], uint64(len(dir)))
	locator := make([]byte, 20)
	put32(locator, 0x07064b50)
	put64(locator[8:], uint64(len(dir)))
	put32(locator[16:], 1)
	end := make([]byte, 22)
	put32(end, 0x06054b50)
	put16(end[8:], 0xffff)
	put16(end[10:], 0xffff)
	put32(end[12:], 0xffffffff)
	put32(end[16:], 0xffffffff)
	data := append(append(append(dir, record...), locator...), end...)
	entries, err := listZipPreview(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Size != "18014398509482107" || entries[0].Packed != "9007199254740996" {
		t.Fatalf("ZIP64: %+v", entries)
	}
	// ZIP64 must also honor its recorded offset when a decoy index lies
	// immediately before the end record.
	fake := append([]byte(nil), dir...)
	copy(fake[46:], "decoy.bin")
	movedLocator := append([]byte(nil), locator...)
	put64(movedLocator[8:], uint64(len(dir)+4+len(fake)))
	withDecoy := append(append(append(append(append(append([]byte(nil), dir...), []byte("GAP!")...), fake...), record...), movedLocator...), end...)
	listed, err := listZipPreview(bytes.NewReader(withDecoy), int64(len(withDecoy)))
	if err != nil || len(listed) != 1 || listed[0].Name != "large.bin" {
		t.Fatalf("ZIP64 directory offset: %+v, %v", listed, err)
	}
}

func TestZipPreviewRejectsForgedAndExcessiveDirectories(t *testing.T) {
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	for i := 0; i < maxZipPreviewEntries+1; i++ {
		if _, err := w.CreateHeader(&zip.FileHeader{Name: fmt.Sprint(i)}); err != nil {
			t.Fatal(err)
		}
	}
	w.Close()
	data := out.Bytes()
	if _, err := listZipPreview(bytes.NewReader(data), int64(len(data))); !errors.Is(err, errZipPreviewLimit) {
		t.Fatalf("too many: %v", err)
	}
	// Lie about the record count: the actual headers must also be checked.
	binary.LittleEndian.PutUint16(data[len(data)-22+8:], 1)
	binary.LittleEndian.PutUint16(data[len(data)-22+10:], 1)
	if _, err := listZipPreview(bytes.NewReader(data), int64(len(data))); !errors.Is(err, errZipPreviewLimit) {
		t.Fatalf("forged count: %v", err)
	}
	for _, bad := range [][]byte{nil, []byte("not a ZIP"), data[:len(data)-10]} {
		if _, err := listZipPreview(bytes.NewReader(bad), int64(len(bad))); err == nil {
			t.Fatal("invalid ZIP accepted")
		}
	}
	end := make([]byte, 22)
	binary.LittleEndian.PutUint32(end, 0x06054b50)
	binary.LittleEndian.PutUint32(end[12:], maxZipPreviewDirectory+1)
	if _, err := listZipPreview(bytes.NewReader(end), 22); !errors.Is(err, errZipPreviewLimit) {
		t.Fatalf("large index: %v", err)
	}
}

func TestTunnelZipPreview(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	s := login(t, ctx, srv.URL, code(0))
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	f, _ := w.Create("hello.txt")
	io.WriteString(f, "hello")
	w.Close()
	os.WriteFile(filepath.Join(g.downloadsDir, "archive.zip"), out.Bytes(), 0o600)
	ask := func(path string) map[string]any {
		tc := openSession(t, ctx, srv.URL, s)
		defer tc.c.CloseNow()
		return tc.request(t, ctx, tunnelRequest{Type: "zip-preview", Path: path})
	}
	r := ask("archive.zip")
	entries, ok := r["entries"].([]any)
	if r["ok"] != true || !ok || len(entries) != 1 || entries[0].(map[string]any)["name"] != "hello.txt" {
		t.Fatalf("reply: %v", r)
	}
	outside := filepath.Join(t.TempDir(), "outside.zip")
	os.WriteFile(outside, out.Bytes(), 0o600)
	os.Symlink(outside, filepath.Join(g.downloadsDir, "escape.zip"))
	for _, p := range []string{"../outside.zip", "escape.zip", "."} {
		if r := ask(p); r["error"] == nil {
			t.Fatalf("accepted %q: %v", p, r)
		}
	}
}

func TestZipPreviewRecordedDirectoryOffset(t *testing.T) {
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	f, _ := w.Create("important.txt")
	f.Write([]byte("content"))
	w.Close()
	original := out.Bytes()
	end := append([]byte(nil), original[len(original)-22:]...)
	offset := int(binary.LittleEndian.Uint32(end[16:]))
	length := int(binary.LittleEndian.Uint32(end[12:]))
	fake := append([]byte(nil), original[offset:offset+length]...)
	copy(fake[46:], "innocuous.txt")
	gap := append(append(append([]byte(nil), original[:len(original)-22]...), []byte("GAP!")...), end...)
	decoy := append(append(append(append([]byte(nil), original[:len(original)-22]...), []byte("GAP!")...), fake...), end...)
	prefixed := append([]byte("MZ self-extracting prefix"), original...)
	signature := []byte{'P', 'K', 5, 5, 3, 0, 's', 'i', 'g'}
	signedEnd := append([]byte(nil), end...)
	binary.LittleEndian.PutUint32(signedEnd[12:], uint32(length+len(signature)))
	signed := append(append(append([]byte(nil), original[:len(original)-22]...), signature...), signedEnd...)
	for name, data := range map[string][]byte{"gap": gap, "decoy": decoy, "prefixed": prefixed, "signed": signed} {
		t.Run(name, func(t *testing.T) {
			native, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
			if err != nil {
				t.Fatal(err)
			}
			entries, err := listZipPreview(bytes.NewReader(data), int64(len(data)))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 || entries[0].Name != native.File[0].Name || entries[0].Name != "important.txt" {
				t.Fatalf("listing differs from ZIP reader: %+v", entries)
			}
		})
	}
	// Invalid offsets must not be used for reads or allocation.
	invalid := append([]byte(nil), original...)
	binary.LittleEndian.PutUint32(invalid[len(invalid)-22+16:], uint32(len(invalid)+100))
	if _, err := listZipPreview(bytes.NewReader(invalid), int64(len(invalid))); err == nil {
		t.Fatal("accepted out-of-bounds directory offset")
	}
}

func TestZipPreviewFilenameEncodings(t *testing.T) {
	for _, test := range []struct {
		name       string
		utf8       bool
		unicode    string
		corruptCRC bool
		want       string
	}{
		{name: "caf\x82.txt", want: "café.txt"},
		{name: "hello.txt", want: "hello.txt"},
		{name: "日本語.txt", utf8: true, want: "日本語.txt"},
		{name: "日本語.txt", utf8: true, unicode: "wrong.txt", want: "日本語.txt"},
		{name: "caf\x82.txt", unicode: "\xff", want: "café.txt"},
		{name: "legacy.txt", unicode: "日本語.txt", want: "日本語.txt"},
		{name: "caf\x82.txt", unicode: "wrong.txt", corruptCRC: true, want: "café.txt"},
	} {
		t.Run(test.want+test.unicode, func(t *testing.T) {
			var out bytes.Buffer
			w := zip.NewWriter(&out)
			h := &zip.FileHeader{Name: test.name, NonUTF8: !test.utf8}
			if test.unicode != "" {
				payload := make([]byte, 5+len(test.unicode))
				payload[0] = 1
				sum := crc32.ChecksumIEEE([]byte(test.name))
				if test.corruptCRC {
					sum++
				}
				binary.LittleEndian.PutUint32(payload[1:], sum)
				copy(payload[5:], test.unicode)
				h.Extra = make([]byte, 4)
				binary.LittleEndian.PutUint16(h.Extra, 0x7075)
				binary.LittleEndian.PutUint16(h.Extra[2:], uint16(len(payload)))
				h.Extra = append(h.Extra, payload...)
			}
			if _, err := w.CreateHeader(h); err != nil {
				t.Fatal(err)
			}
			w.Close()
			entries, err := listZipPreview(bytes.NewReader(out.Bytes()), int64(out.Len()))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 || entries[0].Name != test.want {
				t.Fatalf("want %q, got %+v", test.want, entries)
			}
		})
	}
}
