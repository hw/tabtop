//go:build heif && !(linux && (amd64 || arm64))

package main

import "errors"

func heifSandbox() error { return errors.New("there's no sandbox for this system") }
