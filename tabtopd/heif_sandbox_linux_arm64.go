//go:build heif && linux

package main

import "golang.org/x/sys/unix"

const heifAuditArch = unix.AUDIT_ARCH_AARCH64

// arm64 hasn't older forms of the calls heifDenied has.
var heifLegacyDenied []uintptr
