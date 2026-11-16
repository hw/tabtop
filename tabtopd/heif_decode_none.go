//go:build !heif

package main

// Without -tags heif (a build without libheif installed), HEIC pictures
// aren't decoded: they're said to be unsupported (see heif.go).
func decodeHEIF([]byte, bool) (heifPicture, error) { return heifPicture{}, errHEIFUnsupported }
