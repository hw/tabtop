//go:build !linux

package main

import "os"

// birthTime: see birth_linux.go. Not known here.
func birthTime(*os.File) int64 { return 0 }
