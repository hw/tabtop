package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

// The offline client's assets: the manifest the gateway writes into the
// pack's tabtop.html when it seals it lists what it serves, with the hash
// of each; each is sent through the tunnel as it's hashed there; and
// nothing else is, however it's named.
func TestOfflineAssets(t *testing.T) {
	g, srv := newE2EServer(t)
	ctx := testCtx(t)
	write := func(dir, name, body string) {
		os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755)
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	hl, dis, kai := t.TempDir(), t.TempDir(), t.TempDir()
	for _, name := range highlightFiles {
		write(hl, name, "hl "+name)
	}
	for _, e := range disasmEngines {
		for _, name := range e.files {
			write(dis, name, "disasm "+name)
		}
	}
	write(dis, "demangle.wasm", "demangle")
	write(kai, "formats.json", `[]`)
	write(kai, "schemas.json", `{}`)
	write(kai, "parsers/a-AAAA.js", `import{a}from"./chunk-BBBB.js";`)
	write(kai, "parsers/chunk-BBBB.js", `export const a=1;`)
	write(kai, "sources/a.ksy", "not served")
	outside := filepath.Join(t.TempDir(), "secret.js")
	os.WriteFile(outside, []byte("secret"), 0o644)
	os.Symlink(outside, filepath.Join(kai, "parsers", "link.js"))
	g.highlightDir, g.disasmDir, g.kaitaiDir, g.disasmOff = hl, dis, kai, "capstone"
	// pdf.js, its folders read as the gateway reads them as it starts.
	g.pdfjsDir = t.TempDir()
	for _, name := range []string{"pdf.min.mjs", "pdf.worker.min.mjs", "cmaps/Adobe-Japan1-UCS2.bcmap", "standard_fonts/FoxitSans.pfb", "wasm/openjpeg.wasm"} {
		write(g.pdfjsDir, name, "pdfjs "+name)
	}
	g.pdfjsNames = pdfjsFiles(g.pdfjsDir)
	// three.js, ONNX Runtime, the AI tools' models, KaTeX and Mermaid, each set whole.
	for _, set := range []struct {
		dir   *string
		files []string
	}{{&g.threeDir, threeFiles}, {&g.backgroundDir, backgroundFiles}, {&g.segmentDir, segmentFiles}, {&g.inpaintDir, inpaintFiles}, {&g.previewDir, previewFiles}} {
		*set.dir = t.TempDir()
		for _, name := range set.files {
			write(*set.dir, name, "asset "+name)
		}
	}

	g.offlineClient = true
	plain, err := g.offlineClientPlain()
	if err != nil {
		t.Fatal(err)
	}
	html := string(plain)
	if strings.Contains(html, offlineAssetsSentinel) {
		t.Fatal("the manifest wasn't written into tabtop.html")
	}
	at := strings.Index(html, "const ASSETS = ")
	if at < 0 {
		t.Fatal("tabtop.html has no ASSETS")
	}
	var m offlineManifest
	if err := json.NewDecoder(strings.NewReader(html[at+len("const ASSETS = "):])).Decode(&m); err != nil {
		t.Fatalf("the manifest: %v", err)
	}
	want := []string{"tabtop/highlight/highlight.min.js", "tabtop/highlight/languages/dos.min.js", "tabtop/disasm/iced.js",
		"tabtop/disasm/iced_x86_bg.wasm", "tabtop/disasm/arm64-asm.wasm", "tabtop/x86-asm.js", "tabtop/asm-common.js",
		"tabtop/riscv-asm.js", "tabtop/mips-asm.js", "tabtop/demangle/demangle.wasm", "tabtop/kaitai/formats.json",
		"tabtop/kaitai/schemas.json", "tabtop/kaitai/parsers/a-AAAA.js", "tabtop/kaitai/parsers/chunk-BBBB.js",
		"tabtop/three/three.module.js", "tabtop/three/draco_decoder.wasm", "tabtop/background/ort.wasm.min.js",
		"tabtop/background/ort-wasm-simd-threaded.mjs", "tabtop/background/u2netp.onnx", "tabtop/segment/mobile_sam_encoder.onnx",
		"tabtop/inpaint/migan.onnx", "tabtop/highlight/classic/highlight.min.js", "tabtop/pdfjs/pdf.min.mjs",
		"tabtop/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap", "tabtop/pdfjs/wasm/openjpeg.wasm", "tabtop/preview/katex.min.js", "tabtop/preview/mermaid.min.js"}
	for _, name := range want {
		if _, ok := m.Files[name]; !ok {
			t.Errorf("the manifest hasn't %s", name)
		}
	}
	for name := range m.Files {
		if strings.Contains(name, "capstone") || strings.Contains(name, "sources/") || strings.Contains(name, "link.js") {
			t.Errorf("the manifest has %s, which it shouldn't", name)
		}
	}
	if strings.Join(m.DisasmOff, ",") != "capstone" {
		t.Errorf("disasmOff %v, want capstone", m.DisasmOff)
	}

	s := login(t, ctx, srv.URL, code(0))
	fetch := func(name string) ([]byte, map[string]any) {
		tc := openSession(t, ctx, srv.URL, s)
		reply := tc.request(t, ctx, tunnelRequest{Type: "asset", Path: name})
		if reply["error"] != nil {
			return nil, reply
		}
		var got []byte
		for {
			kind, p, err := tc.read(ctx)
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				return got, reply
			}
			if err != nil || kind != msgData {
				t.Fatalf("%s: kind %d: %v", name, kind, err)
			}
			got = append(got, p...)
			tc.write(ctx, msgData, nil)
		}
	}
	for name, sum := range m.Files {
		got, reply := fetch(name)
		h := sha256.Sum256(got)
		if hex.EncodeToString(h[:]) != sum.SHA256 || len(got) != sum.Size || reply["size"] != float64(sum.Size) {
			t.Errorf("%s: got %d bytes (%v), not as the manifest has it", name, len(got), reply)
		}
	}
	for _, name := range []string{"tabtop/kaitai/sources/a.ksy", "tabtop/kaitai/parsers/link.js", "tabtop/kaitai/../../etc/passwd",
		"tabtop/highlight/../files.js", "tabtop/disasm/capstone.js", "tabtop/files.js", ""} {
		if _, reply := fetch(name); reply["error"] == nil {
			t.Errorf("%q was sent: %v", name, reply)
		}
	}
}

// The previews' frames the offline client builds (from the pack's
// tabtop/*-frame.html: see scripts/bootstrap/build-full-client.mjs) are
// the gateway's, as it serves them.
func TestOfflineFrames(t *testing.T) {
	var pack struct {
		Files map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(bootstrapClientJSON, &pack); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"tabtop/md-frame.html": mdFrameHTML, "tabtop/epub-frame.html": epubFrameHTML, "tabtop/pdf-frame.html": pdfFrameHTML, "tabtop/go-frame.html": goFrameHTML} {
		var got string
		if err := json.Unmarshal(pack.Files[name], &got); err != nil || got != want {
			t.Errorf("the pack's %s isn't the gateway's (rebuild it: node scripts/bootstrap/build-full-client.mjs)", name)
		}
	}
}

// A gateway that doesn't accept the offline client seals tabtop.html as
// built (no ASSETS injection), and reads none of the viewers' files; one
// that does reads them from their folders, not into the sets its own pages
// are served from.
func TestOfflineManifestLoadsNothing(t *testing.T) {
	g, _ := newE2EServer(t)
	g.threeDir = t.TempDir()
	for _, name := range threeFiles {
		os.WriteFile(filepath.Join(g.threeDir, name), []byte("// "+name), 0o644)
	}
	var pack struct {
		Files map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(bootstrapClientJSON, &pack); err != nil {
		t.Fatal(err)
	}
	var builtHTML string
	if err := json.Unmarshal(pack.Files["tabtop.html"], &builtHTML); err != nil {
		t.Fatal(err)
	}
	if plain, err := g.offlineClientPlain(); err != nil || string(plain) != builtHTML {
		t.Fatalf("without -offline-client, plaintext isn't the built tabtop.html: %v", err)
	}
	g.offlineClient = true
	if _, err := g.offlineClientPlain(); err != nil {
		t.Fatal(err)
	}
	g.three.mu.Lock()
	loaded := g.three.files != nil
	g.three.mu.Unlock()
	if loaded {
		t.Error("sealing the pack loaded three.js's set")
	}
}
