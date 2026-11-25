//go:build !(linux && (amd64 || arm64))

package main

import "errors"

func childSandbox() error { return errors.New("there's no sandbox for this system") }
