package main

// The viewers the offline client (the bootstrap pack's tabtop.html; see
// scripts/bootstrap/file-launcher.mjs) doesn't carry, which it fetches
// through the tunnel when they're first needed (the "asset" request) and
// keeps in the browser: highlight.js, the disassemblers and the demangler,
// the Kaitai formats, three.js (the 3D preview) and its decoders, ONNX
// Runtime and the models of the AI image tools, pdf.js, and KaTeX and
// Mermaid (the Markdown preview's maths and diagrams). Which files it may have, and the SHA-256 of
// each, are written into the pack's tabtop.html when the pack is sealed
// (offlineClientPlain), so what it fetches is checked against what was
// unlocked with the passcode: none that differs is run.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"slices"
	"strings"
)

// offlineAssetsSentinel is what tabtop.html has where the manifest goes:
// valid JavaScript (null, no manifest) until it's replaced.
const offlineAssetsSentinel = "/*tabtop-offline-assets*/null"

// The most bytes one asset may be (the largest, MobileSAM's encoder and
// MI-GAN, are under 30 MB).
const maxOfflineAsset = 64 << 20

// offlineAssets is every file the offline client may fetch, by its path
// in the client's tree (tabtop/…, where the gateway serves it, but for
// the version in the name), each read when asked, from its folder (not
// the copies the gateway's own pages are served from, which are only
// loaded as those pages need them): what this gateway serves to its own
// pages.
func (g *server) offlineAssets() map[string]func() ([]byte, error) {
	out := map[string]func() ([]byte, error){}
	have := func(name string, data []byte) {
		out[name] = func() ([]byte, error) { return data, nil }
	}
	fromDisk := func(as assets) {
		if as.dir == "" {
			return
		}
		for _, name := range as.names {
			out["tabtop/"+as.label+"/"+name] = func() ([]byte, error) { return readAsset(as.dir, name) }
		}
	}
	// highlight.js: its module build, and its classic one (the Markdown
	// frame's).
	fromDisk(g.highlightAssets())
	// Each disassembler that's on: its files, and the scripts of tabtopd's
	// own it needs (x86's assembler; RISC-V's and MIPS's, which are only
	// scripts, and what they share).
	off := g.disasmUnavailable()
	scripts := map[string][]string{"x86": {"x86-asm.js"}, "riscv": {"asm-common.js", "riscv-asm.js"}, "mips": {"asm-common.js", "mips-asm.js"}}
	for i, e := range disasmEngines {
		if slices.Contains(off, e.name) {
			continue
		}
		if len(e.files) > 0 {
			_, files := g.disasm[i].load(assets{"disasm", g.disasmDir, e.files})
			for name, a := range files {
				have("tabtop/disasm/"+name, a.data)
			}
		}
		for _, name := range scripts[e.name] {
			if data, err := pageFiles.ReadFile(name); err == nil {
				have("tabtop/"+name, data)
			}
		}
	}
	// three.js and its decoders; ONNX Runtime and U2NetP (background
	// removal), MobileSAM (magic select) and MI-GAN (inpainting); pdf.js;
	// KaTeX and Mermaid; the demangler.
	for _, as := range []assets{g.threeAssets(), g.backgroundAssets(), g.segmentAssets(), g.inpaintAssets(), g.pdfjsAssets(),
		g.previewAssets(), g.demangleAssets()} {
		fromDisk(as)
	}
	// Kaitai: its catalogue, its schemas, and its compiled parsers (and the
	// chunks they share), read from the folder each time, as serveKaitai does.
	if g.kaitaiDir != "" {
		names := []string{"formats.json", "schemas.json"}
		if entries, err := os.ReadDir(path.Join(g.kaitaiDir, "parsers")); err == nil {
			for _, e := range entries {
				if e.Type().IsRegular() && path.Ext(e.Name()) == ".js" {
					names = append(names, "parsers/"+e.Name())
				}
			}
		}
		for _, name := range names {
			out["tabtop/kaitai/"+name] = func() ([]byte, error) { return readAsset(g.kaitaiDir, name) }
		}
	}
	return out
}

// readAsset reads name (one of offlineAssets' files) from dir, not
// following a link out of it.
func readAsset(dir, name string) ([]byte, error) {
	if !fs.ValidPath(name) {
		return nil, fs.ErrInvalid
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	f, err := root.OpenFile(name, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > maxOfflineAsset {
		return nil, fs.ErrInvalid
	}
	data := make([]byte, st.Size())
	if _, err := f.ReadAt(data, 0); err != nil && st.Size() > 0 {
		return nil, err
	}
	return data, nil
}

// offlineManifest is what offlineClientPlain writes into tabtop.html: each
// asset's SHA-256 and size, and the disassemblers that are off.
type offlineManifest struct {
	Files     map[string]offlineAssetSum `json:"files"`
	DisasmOff []string                   `json:"disasmOff"`
}

type offlineAssetSum struct {
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
}

func (g *server) offlineManifest() (offlineManifest, error) {
	m := offlineManifest{Files: map[string]offlineAssetSum{}, DisasmOff: g.disasmUnavailable()}
	for name, read := range g.offlineAssets() {
		data, err := read()
		if err != nil {
			continue // as the gateway's own pages, the client goes without
		}
		sum := sha256.Sum256(data)
		m.Files[name] = offlineAssetSum{hex.EncodeToString(sum[:]), len(data)}
	}
	return m, nil
}

// offlineClientPlain is the UTF-8 tabtop.html sealed as /auth/pack plaintext.
// It is taken from the embedded tabtop-pack/v1 tree (bootstrap.client.json).
// With -offline-client, this gateway's ASSETS manifest is written into it;
// without, the built HTML is sealed as-is (the pack then has no use for connect).
func (g *server) offlineClientPlain() ([]byte, error) {
	var pack map[string]json.RawMessage
	if err := json.Unmarshal(bootstrapClientJSON, &pack); err != nil {
		return nil, err
	}
	var files map[string]json.RawMessage
	if err := json.Unmarshal(pack["files"], &files); err != nil {
		return nil, err
	}
	var html string
	if err := json.Unmarshal(files["tabtop.html"], &html); err != nil {
		return nil, fmt.Errorf("the pack's tabtop.html: %w", err)
	}
	if !g.offlineClient {
		return []byte(html), nil
	}
	if n := strings.Count(html, offlineAssetsSentinel); n != 1 {
		return nil, fmt.Errorf("the pack's tabtop.html has %d places for the manifest of assets, not 1", n)
	}
	m, err := g.offlineManifest()
	if err != nil {
		return nil, err
	}
	// (json.Marshal escapes "<", ">" and "&": it can't end the script it's in.)
	manifest, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	html = strings.Replace(html, offlineAssetsSentinel, string(manifest), 1)
	return []byte(html), nil
}

// routeAsset sends one of offlineAssets' files, by its path: an exact
// name of them, never a path that's looked up on disk as it's given.
func (g *server) routeAsset(c *tunnelCall) {
	read, ok := g.offlineAssets()[c.req.Path]
	if !ok {
		c.r.fail("That isn't one of the offline client's files.")
		return
	}
	data, err := read()
	if err != nil || len(data) > maxOfflineAsset {
		c.r.fail("That file can't be read here.")
		return
	}
	if !c.r.accept(map[string]any{"name": path.Base(c.req.Path), "size": len(data)}) {
		return
	}
	w := newChunkWriter(c.t)
	defer w.stop()
	if _, err := w.Write(data); err != nil {
		w.fail(err)
		return
	}
	if w.flush() == nil {
		c.r.finish(nil)
	}
}
