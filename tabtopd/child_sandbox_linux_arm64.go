package main

import "golang.org/x/sys/unix"

const childAuditArch = unix.AUDIT_ARCH_AARCH64

// arm64 hasn't older forms of the calls childDenied has.
var childLegacyDenied []uintptr
