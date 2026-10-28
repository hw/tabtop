package main

// #cgo pkg-config: opus
// #include <opus.h>
//
// // opus_encoder_ctl is variadic, which cgo can't call.
// static int set_bitrate(OpusEncoder *e, opus_int32 v) { return opus_encoder_ctl(e, OPUS_SET_BITRATE(v)); }
// static int set_vbr(OpusEncoder *e, opus_int32 v) { return opus_encoder_ctl(e, OPUS_SET_VBR(v)); }
// static int get_lookahead(OpusEncoder *e, opus_int32 *v) { return opus_encoder_ctl(e, OPUS_GET_LOOKAHEAD(v)); }
import "C"

import (
	"bytes"
	"unsafe"
)

// opusEncoder wraps libopus. It isn't safe for concurrent use.
type opusEncoder struct {
	enc      *C.OpusEncoder
	channels int
	out      []byte
}

// newOpusEncoder uses the restricted low-delay mode: CELT only, with 2.5 ms
// of lookahead instead of 6.5 ms. Desktop audio is mostly music and system
// sounds, which CELT handles well at the bitrates used here.
//
// Constant bitrate: with VBR, silence shrinks to a few bytes per frame, and
// Chromium's <audio> element then waits many seconds for enough data before
// it starts playing the Ogg stream.
func newOpusEncoder(rate, channels, bitrate int) (*opusEncoder, error) {
	var status C.int
	enc := C.opus_encoder_create(C.opus_int32(rate), C.int(channels), C.OPUS_APPLICATION_RESTRICTED_LOWDELAY, &status)
	if status != C.OPUS_OK {
		return nil, opusError(status)
	}
	if status = C.set_bitrate(enc, C.opus_int32(bitrate)); status == C.OPUS_OK {
		status = C.set_vbr(enc, 0)
	}
	if status != C.OPUS_OK {
		C.opus_encoder_destroy(enc)
		return nil, opusError(status)
	}
	return &opusEncoder{enc: enc, channels: channels, out: make([]byte, 1500)}, nil
}

// encode turns one frame of interleaved samples into an Opus packet.
func (e *opusEncoder) encode(pcm []int16) ([]byte, error) {
	n := C.opus_encode(e.enc, (*C.opus_int16)(unsafe.Pointer(&pcm[0])), C.int(len(pcm)/e.channels),
		(*C.uchar)(unsafe.Pointer(&e.out[0])), C.opus_int32(len(e.out)))
	if n < 0 {
		return nil, opusError(n)
	}
	return bytes.Clone(e.out[:n]), nil
}

// lookahead is the encoder's delay in samples, which an Ogg Opus stream
// declares as its pre-skip.
func (e *opusEncoder) lookahead() int {
	var v C.opus_int32
	C.get_lookahead(e.enc, &v)
	return int(v)
}

func (e *opusEncoder) close() { C.opus_encoder_destroy(e.enc) }

type opusError C.int

func (e opusError) Error() string { return "opus: " + C.GoString(C.opus_strerror(C.int(e))) }
