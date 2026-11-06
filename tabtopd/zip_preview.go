package main

// ZIP listings read directory metadata only. Extraction lives in zip_extract.go.
// Copy the bounded directory into a synthetic ZIP before archive/zip parses it,
// so forged counts/offsets cannot cause unbounded allocation or payload reads.
import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"io/fs"
	"strings"
	"unicode/utf8"
)

var zipPreviewSlots = newPreviewWork(previewReadConcurrency)

type zipPreviewEntry struct {
	Unavailable string `json:"unavailable,omitempty"`
	Index       int    `json:"index"`
	Extractable bool   `json:"extractable"`
	Name        string `json:"name"`
	Size        string `json:"size"` // Decimal strings preserve ZIP64 sizes exactly.
	Packed      string `json:"packed"`
	Modified    string `json:"modified,omitempty"`
	Kind        string `json:"kind"`
	Encrypted   bool   `json:"encrypted,omitempty"`
}

// ZIP's legacy filename encoding is CP437. UTF-8 is selected by flag 11
// or a version-1 Info-ZIP Unicode Path field with a matching raw-name CRC.
var zipCP437High = []rune("ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ")

func zipPreviewName(f *zip.File) (string, error) {
	if f.Flags&0x800 != 0 {
		if !utf8.ValidString(f.Name) {
			return "", zip.ErrFormat
		}
		return f.Name, nil
	}
	nameCRC := crc32.ChecksumIEEE([]byte(f.Name))
	extra := f.Extra
	for len(extra) >= 4 {
		tag, n := binary.LittleEndian.Uint16(extra), int(binary.LittleEndian.Uint16(extra[2:]))
		extra = extra[4:]
		if n > len(extra) {
			break
		}
		field := extra[:n]
		if tag == 0x7075 && len(field) > 5 && field[0] == 1 &&
			binary.LittleEndian.Uint32(field[1:]) == nameCRC && utf8.Valid(field[5:]) {
			return string(field[5:]), nil
		}
		extra = extra[n:]
	}
	var name strings.Builder
	for i := 0; i < len(f.Name); i++ {
		b := f.Name[i]
		if b < 128 {
			name.WriteByte(b)
		} else {
			name.WriteRune(zipCP437High[int(b)-128])
		}
	}
	return name.String(), nil
}

func listZipPreview(r io.ReaderAt, size int64) ([]zipPreviewEntry, error) {
	directory, err := zipPreviewDirectory(r, size)
	if err != nil {
		return nil, err
	}
	zr, err := zip.NewReader(bytes.NewReader(directory), int64(len(directory)))
	if err != nil && !errors.Is(err, zip.ErrInsecurePath) {
		return nil, err
	}
	entries := make([]zipPreviewEntry, 0, len(zr.File))
	for index, f := range zr.File {
		name, err := zipPreviewName(f)
		if err != nil {
			return nil, err
		}
		kind := "File"
		if f.FileInfo().IsDir() {
			kind = "Folder"
		} else if f.Mode()&fs.ModeSymlink != 0 {
			kind = "Symlink"
		}
		modified := ""
		if !f.Modified.IsZero() {
			modified = f.Modified.UTC().Format("2006-01-02T15:04:05Z")
		}
		_, extractable := zipExtractName(f)
		reason := ""
		switch {
		case f.Flags&1 != 0:
			reason = "Encrypted"
		case f.Mode()&fs.ModeSymlink != 0:
			reason = "Symlink"
		case f.FileInfo().IsDir():
			reason = "Folder — select individual files"
		case f.Method != zip.Store && f.Method != zip.Deflate:
			reason = "Unsupported compression"
		case !extractable:
			reason = "Unsafe path or file type"
		case f.UncompressedSize64 > maxZipExtractBytes:
			reason = "Exceeds 512 MiB limit"
		}
		extractable = reason == ""
		entries = append(entries, zipPreviewEntry{Index: index, Extractable: extractable, Unavailable: reason, Name: name, Size: fmt.Sprint(f.UncompressedSize64), Packed: fmt.Sprint(f.CompressedSize64), Modified: modified, Kind: kind, Encrypted: f.Flags&1 != 0})
	}
	return entries, nil
}

func (g *server) tunnelZipPreview(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	release, ok := zipPreviewSlots.acquire()
	if !ok {
		r.fail("Other ZIP files are being listed; try again in a moment.")
		return
	}
	defer release()
	opened, err := openDownloadsFile(g.downloadsDir, req.Path)
	if err != nil {
		r.fail(err.Error())
		return
	}
	defer opened.Close()
	f, st := opened.file, opened.info
	entries, err := listZipPreview(f, st.Size())
	if err != nil {
		r.fail("ZIP can't be listed: " + err.Error())
		return
	}
	after, err := f.Stat()
	if err != nil || fileVersion(after) != fileVersion(st) || after.Size() != st.Size() {
		r.fail("The ZIP changed while it was being listed; open it again.")
		return
	}
	r.finish(map[string]any{"entries": entries, "size": st.Size(), "mtime": fileVersion(st)})
}
