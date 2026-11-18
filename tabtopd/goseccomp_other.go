//go:build !linux || !(amd64 || arm64)

package main

import "os"

// No filter for this architecture (see goseccomp.go): the sandbox runs
// without one.
func goSeccompProgram() []byte { return nil }

func goSeccompFile() (*os.File, error) { return nil, nil }
