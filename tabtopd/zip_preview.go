package main

// ZIP previews read directory metadata only. No entry is opened or extracted.
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
	"path"
	"strings"
	"unicode/utf8"
)

const maxZipPreviewEntries = 10000
const maxZipPreviewDirectory = 4 << 20

var zipPreviewSlots = make(chan struct{}, 2)
var errZipPreviewLimit = errors.New("ZIP directory is too large to preview (limit: 10,000 entries and 4 MB of metadata); download it instead")

type zipPreviewEntry struct {
	Name      string `json:"name"`
	Size      string `json:"size"` // Decimal strings preserve ZIP64 sizes exactly.
	Packed    string `json:"packed"`
	Modified  string `json:"modified,omitempty"`
	Kind      string `json:"kind"`
	Encrypted bool   `json:"encrypted,omitempty"`
}

func zipPreviewDirectory(r io.ReaderAt, size int64) ([]byte, error) {
	if size < 22 {
		return nil, zip.ErrFormat
	}
	tailSize := min(size, int64(65535+22))
	tail := make([]byte, tailSize)
	if _, err := r.ReadAt(tail, size-tailSize); err != nil {
		return nil, err
	}
	at := -1
	for i := len(tail) - 22; i >= 0; i-- {
		if binary.LittleEndian.Uint32(tail[i:]) == 0x06054b50 && i+22+int(binary.LittleEndian.Uint16(tail[i+20:])) == len(tail) {
			at = i
			break
		}
	}
	if at < 0 {
		return nil, zip.ErrFormat
	}
	end := tail[at:]
	u16 := binary.LittleEndian.Uint16
	u32 := binary.LittleEndian.Uint32
	u64 := binary.LittleEndian.Uint64
	if u16(end[4:]) != 0 || u16(end[6:]) != 0 {
		return nil, errors.New("split ZIP archives are not supported")
	}
	count, length := uint64(u16(end[10:])), uint64(u32(end[12:]))
	directoryOffset := uint64(u32(end[16:]))
	directoryEnd := size - tailSize + int64(at)
	if count == 0xffff || length == 0xffffffff || u32(end[16:]) == 0xffffffff {
		var locator [20]byte
		if directoryEnd < 20 {
			return nil, zip.ErrFormat
		}
		if _, err := r.ReadAt(locator[:], directoryEnd-20); err != nil {
			return nil, err
		}
		if u32(locator[:]) != 0x07064b50 || u32(locator[4:]) != 0 || u32(locator[16:]) != 1 {
			return nil, zip.ErrFormat
		}
		offset := u64(locator[8:])
		if size < 56 || offset > uint64(size-56) {
			return nil, zip.ErrFormat
		}
		var record [56]byte
		if _, err := r.ReadAt(record[:], int64(offset)); err != nil {
			return nil, err
		}
		if u32(record[:]) != 0x06064b50 || u64(record[4:]) < 44 || u32(record[16:]) != 0 || u32(record[20:]) != 0 || u64(record[24:]) != u64(record[32:]) {
			return nil, zip.ErrFormat
		}
		count, length = u64(record[32:]), u64(record[40:])
		directoryOffset = u64(record[48:])
		directoryEnd = int64(offset)
	} else if u16(end[8:]) != u16(end[10:]) {
		return nil, zip.ErrFormat
	}
	if count > maxZipPreviewEntries || length > maxZipPreviewDirectory {
		return nil, errZipPreviewLimit
	}
	if length > uint64(directoryEnd) {
		return nil, zip.ErrFormat
	}
	inferredOffset := uint64(directoryEnd) - length
	if directoryOffset > inferredOffset {
		return nil, zip.ErrFormat
	}
	if count > 0 && directoryOffset != inferredOffset {
		// Prefer the recorded location even when another plausible directory
		// sits next to the end record. This agrees with archive/zip and avoids
		// presenting a decoy listing. Only relocate for a prepended executable
		// whose first local header confirms the inferred archive base.
		var signature [4]byte
		if _, err := r.ReadAt(signature[:], int64(directoryOffset)); err != nil {
			return nil, err
		}
		if u32(signature[:]) != 0x02014b50 {
			base := inferredOffset - directoryOffset
			if _, err := r.ReadAt(signature[:], int64(base)); err != nil {
				return nil, err
			}
			if u32(signature[:]) != 0x04034b50 {
				return nil, zip.ErrFormat
			}
			directoryOffset = inferredOffset
		}
	}
	directory := make([]byte, int(length)+22)
	if length > 0 {
		if _, err := r.ReadAt(directory[:int(length)], int64(directoryOffset)); err != nil {
			return nil, err
		}
	}
	// Count actual records, not merely the untrusted count in the end record.
	records := 0
	for pos := 0; pos < int(length); {
		// The optional digital-signature record is part of the directory's
		// byte size, but does not count as a file header.
		if int(length)-pos >= 6 && u32(directory[pos:]) == 0x05054b50 {
			if pos+6+int(u16(directory[pos+4:])) != int(length) {
				return nil, zip.ErrFormat
			}
			break
		}
		if int(length)-pos < 46 || u32(directory[pos:]) != 0x02014b50 {
			return nil, zip.ErrFormat
		}
		n := 46 + int(u16(directory[pos+28:])) + int(u16(directory[pos+30:])) + int(u16(directory[pos+32:]))
		if n > int(length)-pos {
			return nil, zip.ErrFormat
		}
		pos += n
		records++
		if records > maxZipPreviewEntries {
			return nil, errZipPreviewLimit
		}
	}
	if uint64(records) != count {
		return nil, zip.ErrFormat
	}
	syntheticEnd := directory[int(length):]
	binary.LittleEndian.PutUint32(syntheticEnd, 0x06054b50)
	binary.LittleEndian.PutUint16(syntheticEnd[8:], uint16(records))
	binary.LittleEndian.PutUint16(syntheticEnd[10:], uint16(records))
	binary.LittleEndian.PutUint32(syntheticEnd[12:], uint32(length))
	return directory, nil
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
	for _, f := range zr.File {
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
		entries = append(entries, zipPreviewEntry{Name: name, Size: fmt.Sprint(f.UncompressedSize64), Packed: fmt.Sprint(f.CompressedSize64), Modified: modified, Kind: kind, Encrypted: f.Flags&1 != 0})
	}
	return entries, nil
}

func (g *server) tunnelZipPreview(t *tunnel, req tunnelRequest, r *tunnelResponder) {
	select {
	case zipPreviewSlots <- struct{}{}:
		defer func() { <-zipPreviewSlots }()
	default:
		r.fail("Other ZIP files are being listed; try again in a moment.")
		return
	}
	store, err := openDownloadStore(g.downloadsDir)
	if err != nil {
		r.fail("The downloads folder is missing.")
		return
	}
	defer store.Close()
	f, st, err := store.open(path.Clean(strings.Trim(req.Path, "/")))
	if err != nil {
		r.fail("Not found.")
		return
	}
	defer f.Close()
	if !st.Mode().IsRegular() {
		r.fail("Not found.")
		return
	}
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
