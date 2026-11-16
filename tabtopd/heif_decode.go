//go:build heif

package main

// libheif's decoding of a HEIF picture, for heif.go's child: built in with
// -tags heif (as the image is; see the Dockerfile), with libheif and its
// libde265 plugin installed. Its pictures come out turned and cropped as
// the file says (its irot, imir and clap), as browsers show AVIF.

/*
#cgo pkg-config: libheif
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <libheif/heif.h>

// The picture in data, as 8-bit RGBA (alpha=1) or RGB; *out its pixels,
// malloc'd, rows of width*channels bytes. With thumbnail, the file's own
// smallest thumbnail that's at least side on its longer side, if it has
// one. 0, or libheif's message in why.
static int tabtop_heif_decode(const void* data, size_t size, int thumbnail, int side, uint64_t max_pixels, uint64_t thumb_max_pixels,
                              unsigned char** out, int* width, int* height, int* alpha, char* why, size_t why_size) {
    *out = NULL;
    struct heif_context* ctx = heif_context_alloc();
    if (!ctx) { snprintf(why, why_size, "out of memory"); return 1; }
    // Tighter than libheif's own: no larger than the picture editor takes.
    struct heif_security_limits* limits = heif_context_get_security_limits(ctx);
    if (limits) {
        limits->max_image_size_pixels = max_pixels;
        if (limits->max_memory_block_size == 0 || limits->max_memory_block_size > (uint64_t)1 << 30) limits->max_memory_block_size = (uint64_t)1 << 30;
        if (limits->version >= 2 && (limits->max_total_memory == 0 || limits->max_total_memory > (uint64_t)3 << 30)) limits->max_total_memory = (uint64_t)3 << 30;
    }
    struct heif_error err = heif_context_read_from_memory_without_copy(ctx, data, size, NULL);
    struct heif_image_handle* handle = NULL;
    struct heif_image* img = NULL;
    int status = 1;
    if (err.code != heif_error_Ok) goto done;
    err = heif_context_get_primary_image_handle(ctx, &handle);
    if (err.code != heif_error_Ok) goto done;
    if (thumbnail) {
        int n = heif_image_handle_get_number_of_thumbnails(handle);
        if (n > 0 && n < 64) {
            heif_item_id ids[64];
            n = heif_image_handle_get_list_of_thumbnail_IDs(handle, ids, n);
            struct heif_image_handle* best = NULL;
            int best_side = 0;
            for (int i = 0; i < n; i++) {
                struct heif_image_handle* t = NULL;
                if (heif_image_handle_get_thumbnail(handle, ids[i], &t).code != heif_error_Ok) continue;
                int w = heif_image_handle_get_width(t), h = heif_image_handle_get_height(t), longer = w > h ? w : h;
                if (longer >= side && (!best || longer < best_side)) {
                    if (best) heif_image_handle_release(best);
                    best = t; best_side = longer;
                } else heif_image_handle_release(t);
            }
            if (best) { heif_image_handle_release(handle); handle = best; }
        }
        // No thumbnail of its own: the picture itself, unless it's so big
        // that decoding it whole for a thumbnail isn't worth it.
        if (heif_image_handle_is_primary_image(handle) &&
                (uint64_t)heif_image_handle_get_width(handle) * (uint64_t)heif_image_handle_get_height(handle) > thumb_max_pixels) {
            snprintf(why, why_size, "The picture is too large to make a thumbnail of.");
            goto failed;
        }
    }
    *alpha = heif_image_handle_has_alpha_channel(handle) ? 1 : 0;
    err = heif_decode_image(handle, &img, heif_colorspace_RGB, *alpha ? heif_chroma_interleaved_RGBA : heif_chroma_interleaved_RGB, NULL);
    if (err.code != heif_error_Ok) goto done;
    *width = heif_image_get_width(img, heif_channel_interleaved);
    *height = heif_image_get_height(img, heif_channel_interleaved);
    size_t stride = 0;
    const uint8_t* plane = heif_image_get_plane_readonly2(img, heif_channel_interleaved, &stride);
    int channels = *alpha ? 4 : 3;
    if (!plane || *width <= 0 || *height <= 0 || (uint64_t)*width * (uint64_t)*height > max_pixels || stride < (size_t)*width * channels) {
        snprintf(why, why_size, "The picture's decoded pixels can't be read.");
        goto failed;
    }
    *out = malloc((size_t)*width * *height * channels);
    if (!*out) { snprintf(why, why_size, "out of memory"); goto failed; }
    for (int y = 0; y < *height; y++) memcpy(*out + (size_t)y * *width * channels, plane + (size_t)y * stride, (size_t)*width * channels);
    status = 0;
    goto failed;
done:
    snprintf(why, why_size, "%s", err.message ? err.message : "The picture couldn't be decoded.");
failed:
    if (img) heif_image_release(img);
    if (handle) heif_image_handle_release(handle);
    heif_context_free(ctx);
    return status;
}
*/
import "C"

import (
	"errors"
	"image"
	"unsafe"
)

// heifPrepare readies the child to decode: libheif's plugins loaded (from
// files: while it can), then the sandbox (see heif_sandbox.go), or why not.
func heifPrepare() error {
	C.heif_init(nil)
	return heifSandbox()
}

// decodeHEIF is the picture in data (the file's own thumbnail, if one is
// asked for and it has one big enough), as RGBA.
func decodeHEIF(data []byte, thumbnail bool) (heifPicture, error) {
	if len(data) == 0 {
		return heifPicture{}, errors.New("The picture is empty.")
	}
	cData := C.CBytes(data)
	defer C.free(cData)
	var out *C.uchar
	var width, height, alpha C.int
	why := make([]byte, 300)
	thumb := C.int(0)
	if thumbnail {
		thumb = 1
	}
	status := C.tabtop_heif_decode(cData, C.size_t(len(data)), thumb, C.int(heifThumbnailSide), C.uint64_t(maxHEIFPixels), C.uint64_t(maxHEIFThumbnailPixels),
		&out, &width, &height, &alpha, (*C.char)(unsafe.Pointer(&why[0])), C.size_t(len(why)))
	if status != 0 {
		return heifPicture{}, errors.New("The picture couldn't be decoded: " + C.GoString((*C.char)(unsafe.Pointer(&why[0]))))
	}
	defer C.free(unsafe.Pointer(out))
	w, h := int(width), int(height)
	channels := 3
	if alpha != 0 {
		channels = 4
	}
	src := unsafe.Slice((*byte)(unsafe.Pointer(out)), w*h*channels)
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	transparent := false
	for i, j := 0, 0; i < len(src); i, j = i+channels, j+4 {
		img.Pix[j], img.Pix[j+1], img.Pix[j+2] = src[i], src[i+1], src[i+2]
		if channels == 4 {
			img.Pix[j+3] = src[i+3]
			transparent = transparent || src[i+3] != 255
		} else {
			img.Pix[j+3] = 255
		}
	}
	return heifPicture{image: img, alpha: transparent}, nil
}
