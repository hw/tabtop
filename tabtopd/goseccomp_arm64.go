package main

import "golang.org/x/sys/unix"

const (
	goSeccompAuditArch = unix.AUDIT_ARCH_AARCH64
	goSeccompX32       = 0 // none
)

var goSeccompArchDenied = []uintptr{unix.SYS_NFSSERVCTL}
