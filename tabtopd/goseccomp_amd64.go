package main

import "golang.org/x/sys/unix"

// x86-64's: its own calls only, and none of x32's (numbered with this bit).
const (
	goSeccompAuditArch = unix.AUDIT_ARCH_X86_64
	goSeccompX32       = 0x40000000
)

var goSeccompArchDenied = []uintptr{unix.SYS_USELIB, unix.SYS_IOPL, unix.SYS_IOPERM, unix.SYS_NFSSERVCTL}
