package main

// #cgo pkg-config: liboath
// #include <stdlib.h>
// #include <liboath/oath.h>
import "C"

import (
	"sync"
	"unsafe"
)

// totpWindow matches window=1 in the entrypoint's pam_oath config: the
// previous and next 30s codes are accepted too, for clock skew.
const totpWindow = 1

var (
	oathOnce sync.Once
	oathErr  error
	// liboath locks the users file against other processes (Xvnc's
	// pam_oath), not against other threads of this one.
	oathMu sync.Mutex
)

// oathAuthenticate checks otp, and pin when the users file sets one, the way
// pam_oath does: through liboath, which records the code as used in the file
// under a lock. A code accepted here or by the desktop login is then refused
// by the other, and still refused after a restart.
func oathAuthenticate(usersFile, user, pin, otp string) error {
	oathOnce.Do(func() {
		if rc := C.oath_init(); rc != C.OATH_OK {
			oathErr = oathError(rc)
		}
	})
	if oathErr != nil {
		return oathErr
	}
	cFile, cUser, cPin, cOTP := C.CString(usersFile), C.CString(user), C.CString(pin), C.CString(otp)
	defer C.free(unsafe.Pointer(cFile))
	defer C.free(unsafe.Pointer(cUser))
	defer C.free(unsafe.Pointer(cPin))
	defer C.free(unsafe.Pointer(cOTP))

	oathMu.Lock()
	defer oathMu.Unlock()
	var last C.time_t
	if rc := C.oath_authenticate_usersfile(cFile, cUser, cOTP, totpWindow, cPin, &last); rc != C.OATH_OK {
		return oathError(rc)
	}
	return nil
}

type oathError C.int

func (e oathError) Error() string { return "oath: " + C.GoString(C.oath_strerror(C.int(e))) }

// rejected reports whether e is a wrong, reused or expired credential rather
// than a problem with the users file.
func (e oathError) rejected() bool {
	switch e {
	case C.OATH_INVALID_OTP, C.OATH_REPLAYED_OTP, C.OATH_BAD_PASSWORD, C.OATH_INVALID_DIGITS:
		return true
	}
	return false
}
