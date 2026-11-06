package main

// ZIP directory parsing is staged so every allocation and read has explicit
// bounds. The resulting synthetic index contains no entry payloads.
import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
)

const (
	maxZipPreviewEntries      = 10000
	maxZipPreviewDirectory    = 4 << 20
	zipEndSize                = 22
	zipMaxComment             = 65535
	zip64LocatorSize          = 20
	zip64EndSize              = 56
	zipDirectoryHeaderSize    = 46
	zipDirectoryLengthsOffset = 28
	zipDigitalSignatureSize   = 6
	zipLocalSignature         = 0x04034b50
	zipDirectorySignature     = 0x02014b50
	zipEndSignature           = 0x06054b50
	zip64EndSignature         = 0x06064b50
	zip64LocatorSignature     = 0x07064b50
	zipDigitalSignature       = 0x05054b50
)

var errZipPreviewLimit = errors.New("ZIP directory is too large to preview (limit: 10,000 entries and 4 MB of metadata); download it instead")

type zipDirectoryInfo struct {
	records, length, offset uint64
	end                     int64
	comment                 string
}

// Field order follows the ZIP end-record layouts; the signature is separate.
type zipEndRecord struct {
	Disk, DirectoryDisk, DiskRecords, Records uint16
	DirectorySize, DirectoryOffset            uint32
	CommentLength                             uint16
}
type zip64LocatorRecord struct {
	Disk   uint32
	Offset uint64
	Disks  uint32
}
type zip64EndRecord struct {
	Size                                                 uint64
	VersionMade, VersionNeeded                           uint16
	Disk, DirectoryDisk                                  uint32
	DiskRecords, Records, DirectorySize, DirectoryOffset uint64
}

func readZipDirectoryEnd(r io.ReaderAt, size int64) (zipDirectoryInfo, error) {
	var info zipDirectoryInfo
	if size < zipEndSize {
		return info, zip.ErrFormat
	}
	tailSize := min(size, int64(zipMaxComment+zipEndSize))
	tail := make([]byte, tailSize)
	if _, err := r.ReadAt(tail, size-tailSize); err != nil {
		return info, err
	}
	for at := len(tail) - zipEndSize; at >= 0; at-- {
		if binary.LittleEndian.Uint32(tail[at:]) != zipEndSignature {
			continue
		}
		var end zipEndRecord
		if err := binary.Read(bytes.NewReader(tail[at+4:at+zipEndSize]), binary.LittleEndian, &end); err != nil {
			return info, err
		}
		if at+zipEndSize+int(end.CommentLength) != len(tail) {
			continue
		}
		if end.Disk != 0 || end.DirectoryDisk != 0 {
			return info, errors.New("split ZIP archives are not supported")
		}
		endOffset := size - tailSize + int64(at)
		if end.Records == 0xffff || end.DirectorySize == 0xffffffff || end.DirectoryOffset == 0xffffffff {
			info, err := readZip64DirectoryEnd(r, size, endOffset)
			info.comment = string(tail[at+zipEndSize:])
			return info, err
		}
		if end.DiskRecords != end.Records {
			return info, zip.ErrFormat
		}
		return zipDirectoryInfo{records: uint64(end.Records), length: uint64(end.DirectorySize), offset: uint64(end.DirectoryOffset), end: endOffset, comment: string(tail[at+zipEndSize:])}, nil
	}
	return info, zip.ErrFormat
}

func readZip64DirectoryEnd(r io.ReaderAt, size, endOffset int64) (zipDirectoryInfo, error) {
	var info zipDirectoryInfo
	if endOffset < zip64LocatorSize {
		return info, zip.ErrFormat
	}
	var locatorBytes [zip64LocatorSize]byte
	if _, err := r.ReadAt(locatorBytes[:], endOffset-zip64LocatorSize); err != nil {
		return info, err
	}
	if binary.LittleEndian.Uint32(locatorBytes[:]) != zip64LocatorSignature {
		return info, zip.ErrFormat
	}
	var locator zip64LocatorRecord
	if err := binary.Read(bytes.NewReader(locatorBytes[4:]), binary.LittleEndian, &locator); err != nil {
		return info, err
	}
	if locator.Disk != 0 || locator.Disks != 1 || size < zip64EndSize || locator.Offset > uint64(size-zip64EndSize) {
		return info, zip.ErrFormat
	}
	var recordBytes [zip64EndSize]byte
	if _, err := r.ReadAt(recordBytes[:], int64(locator.Offset)); err != nil {
		return info, err
	}
	if binary.LittleEndian.Uint32(recordBytes[:]) != zip64EndSignature {
		return info, zip.ErrFormat
	}
	var end zip64EndRecord
	if err := binary.Read(bytes.NewReader(recordBytes[4:]), binary.LittleEndian, &end); err != nil {
		return info, err
	}
	if end.Size < zip64EndSize-12 || end.Disk != 0 || end.DirectoryDisk != 0 || end.DiskRecords != end.Records {
		return info, zip.ErrFormat
	}
	return zipDirectoryInfo{records: end.Records, length: end.DirectorySize, offset: end.DirectoryOffset, end: int64(locator.Offset)}, nil
}

func locateZipDirectory(r io.ReaderAt, info zipDirectoryInfo, limits zipDirectoryLimits) (int64, error) {
	if info.records > limits.entries || info.length > limits.bytes {
		return 0, limits.err
	}
	if info.end < 0 || info.length > uint64(info.end) {
		return 0, zip.ErrFormat
	}
	inferred := uint64(info.end) - info.length
	if info.offset > inferred {
		return 0, zip.ErrFormat
	}
	if info.records == 0 || info.offset == inferred {
		return int64(info.offset), nil
	}
	// Prefer the recorded directory over a plausible decoy near the end. Only
	// relocate for a prepended archive whose first local header confirms its base.
	var signature [4]byte
	if _, err := r.ReadAt(signature[:], int64(info.offset)); err != nil {
		return 0, err
	}
	if binary.LittleEndian.Uint32(signature[:]) == zipDirectorySignature {
		return int64(info.offset), nil
	}
	if _, err := r.ReadAt(signature[:], int64(inferred-info.offset)); err != nil {
		return 0, err
	}
	if binary.LittleEndian.Uint32(signature[:]) != zipLocalSignature {
		return 0, zip.ErrFormat
	}
	return int64(inferred), nil
}

func validateZipDirectory(data []byte, expected uint64, limits zipDirectoryLimits) error {
	records := uint64(0)
	for pos := 0; pos < len(data); {
		remaining := data[pos:]
		if len(remaining) >= zipDigitalSignatureSize && binary.LittleEndian.Uint32(remaining) == zipDigitalSignature {
			if zipDigitalSignatureSize+int(binary.LittleEndian.Uint16(remaining[4:])) != len(remaining) {
				return zip.ErrFormat
			}
			break
		}
		if len(remaining) < zipDirectoryHeaderSize || binary.LittleEndian.Uint32(remaining) != zipDirectorySignature {
			return zip.ErrFormat
		}
		lengths := remaining[zipDirectoryLengthsOffset:]
		nameSize, extraSize, commentSize := binary.LittleEndian.Uint16(lengths), binary.LittleEndian.Uint16(lengths[2:]), binary.LittleEndian.Uint16(lengths[4:])
		n := zipDirectoryHeaderSize + int(nameSize) + int(extraSize) + int(commentSize)
		if n > len(remaining) {
			return zip.ErrFormat
		}
		pos += n
		records++
		if records > limits.entries {
			return limits.err
		}
	}
	if records != expected {
		return zip.ErrFormat
	}
	return nil
}

func zipDirectoryIndex(data []byte, records uint64) ([]byte, error) {
	index := append(data, make([]byte, zipEndSize)...)
	end := index[len(data):]
	binary.LittleEndian.PutUint32(end, zipEndSignature)
	record := zipEndRecord{DiskRecords: uint16(records), Records: uint16(records), DirectorySize: uint32(len(data))}
	if _, err := binary.Encode(end[4:], binary.LittleEndian, record); err != nil {
		return nil, err
	}
	return index, nil
}

type zipDirectoryLimits struct {
	entries, bytes uint64
	err            error
}

var zipListingLimits = zipDirectoryLimits{maxZipPreviewEntries, maxZipPreviewDirectory, errZipPreviewLimit}
var epubDirectoryLimits = zipDirectoryLimits{maxEpubEntries, 8 << 20, errors.New("it has too many files in it or too much ZIP metadata (limit: 20,000 files and 8 MB)")}

func readBoundedZipDirectory(r io.ReaderAt, size int64, limits zipDirectoryLimits) (zipDirectoryInfo, int64, []byte, error) {
	info, err := readZipDirectoryEnd(r, size)
	if err != nil {
		return info, 0, nil, err
	}
	offset, err := locateZipDirectory(r, info, limits)
	if err != nil {
		return info, 0, nil, err
	}
	data := make([]byte, int(info.length))
	if len(data) > 0 {
		if _, err = r.ReadAt(data, offset); err != nil {
			return info, 0, nil, err
		}
	}
	err = validateZipDirectory(data, info.records, limits)
	return info, offset, data, err
}
func zipPreviewDirectory(r io.ReaderAt, size int64) ([]byte, error) {
	info, _, data, err := readBoundedZipDirectory(r, size, zipListingLimits)
	if err != nil {
		return nil, err
	}
	return zipDirectoryIndex(data, info.records)
}

// openBoundedZip gives archive/zip only a validated, immutable directory.
// Payloads still read through the original ReaderAt. A section boundary keeps
// their offsets (including a self-extracting archive's base) unchanged.
func openBoundedZip(r io.ReaderAt, size int64, limits zipDirectoryLimits) (*zip.Reader, error) {
	info, offset, data, err := readBoundedZipDirectory(r, size, limits)
	if err != nil {
		return nil, err
	}
	var tail bytes.Buffer
	tail.Write(data)
	write := func(v any) { _ = binary.Write(&tail, binary.LittleEndian, v) } // bytes.Buffer writes cannot fail
	end := zipEndRecord{DiskRecords: uint16(info.records), Records: uint16(info.records), DirectorySize: uint32(info.length), DirectoryOffset: uint32(info.offset), CommentLength: uint16(len(info.comment))}
	if info.offset >= 0xffffffff {
		write(uint32(zip64EndSignature))
		write(zip64EndRecord{Size: 44, VersionMade: 45, VersionNeeded: 45, DiskRecords: info.records, Records: info.records, DirectorySize: info.length, DirectoryOffset: info.offset})
		write(uint32(zip64LocatorSignature))
		write(zip64LocatorRecord{Offset: uint64(offset) + info.length, Disks: 1})
		end.DirectoryOffset = 0xffffffff
	}
	write(uint32(zipEndSignature))
	write(end)
	tail.WriteString(info.comment)
	// Overlay cached metadata without buffering payloads.
	view := &zipMetadataReader{payload: r, offset: offset, metadata: bytes.NewReader(tail.Bytes())}
	return zip.NewReader(view, offset+int64(tail.Len()))
}

type zipMetadataReader struct {
	payload  io.ReaderAt
	offset   int64
	metadata *bytes.Reader
}

func (r *zipMetadataReader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, errors.New("negative ZIP offset")
	}
	if off >= r.offset {
		return r.metadata.ReadAt(p, off-r.offset)
	}
	n := int(min(int64(len(p)), r.offset-off))
	got, err := r.payload.ReadAt(p[:n], off)
	if err != nil || got != n {
		return got, err
	}
	if n == len(p) {
		return n, nil
	}
	more, err := r.metadata.ReadAt(p[n:], 0)
	return n + more, err
}
