package main

import (
	"net/http"
	"os"
	"path/filepath"
)

// assetBundle is one of the optional bundles of files the pages load from
// a folder of the image's (its -*-dir flag): served under /tabtop/ by a
// path of its own ("<label>-missing", which serves nothing, without its
// folder), given to the offline client, and looked for as tabtopd starts.
// Adding one is a row in assetBundles (and its -*-dir flag).
type assetBundle struct {
	label string
	dir   func(*serverConfig) string
	names []string
	set   func(*server) *assetSet
	// missing is what goes without its files, said if they can't be read
	// as tabtopd starts; with preload, they're read then (else only looked
	// for: they're big, and read when first asked for).
	missing string
	preload bool
}

var (
	highlightBundle = assetBundle{"highlight", func(c *serverConfig) string { return c.highlightDir }, highlightFiles,
		func(g *server) *assetSet { return &g.highlight }, "the highlight.js files; text previews have no colours", true}
	previewBundle = assetBundle{"preview", func(c *serverConfig) string { return c.previewDir }, previewFiles,
		func(g *server) *assetSet { return &g.preview }, "KaTeX and Mermaid; Markdown previews show math and diagrams as their source", false}
	threeBundle = assetBundle{"three", func(c *serverConfig) string { return c.threeDir }, threeFiles,
		func(g *server) *assetSet { return &g.three }, "three.js; 3D previews say they aren't available", true}
	backgroundBundle = assetBundle{"background", func(c *serverConfig) string { return c.backgroundDir }, backgroundFiles,
		func(g *server) *assetSet { return &g.background }, "ONNX Runtime and U2NetP; background removal (and the tools that use its runtime) fail when asked", false}
	segmentBundle = assetBundle{"segment", func(c *serverConfig) string { return c.segmentDir }, segmentFiles,
		func(g *server) *assetSet { return &g.segment }, "MobileSAM; magic select fails when asked", false}
	inpaintBundle = assetBundle{"inpaint", func(c *serverConfig) string { return c.inpaintDir }, inpaintFiles,
		func(g *server) *assetSet { return &g.inpaint }, "MI-GAN; inpainting fails when asked", false}
	demangleBundle = assetBundle{"demangle", func(c *serverConfig) string { return c.disasmDir }, []string{"demangle.wasm"},
		func(g *server) *assetSet { return &g.demangle }, "the demangler; binary previews show symbols' names as they're stored", false}

	// assetBundles are them all. (pdf.js isn't one: its files are listed
	// as tabtopd starts, pdfjsFiles.)
	assetBundles = []*assetBundle{&highlightBundle, &previewBundle, &threeBundle, &backgroundBundle, &segmentBundle, &inpaintBundle, &demangleBundle}
)

// bundleAssets is b's files, as its set loads them.
func (g *server) bundleAssets(b *assetBundle) assets {
	return assets{b.label, b.dir(&g.serverConfig), b.names}
}

// bundlePath is where b's files are served, under /tabtop/.
func (g *server) bundlePath(b *assetBundle) string {
	if b.dir(&g.serverConfig) == "" {
		return b.label + "-missing"
	}
	return b.set(g).path(g.bundleAssets(b))
}

// serveBundle serves name if it's one of a bundle's files, reporting
// whether it was.
func (g *server) serveBundle(w http.ResponseWriter, r *http.Request, name string) bool {
	for _, b := range assetBundles {
		if b.dir(&g.serverConfig) != "" && b.set(g).serve(w, r, g.bundleAssets(b), name) {
			return true
		}
	}
	return false
}

// bundlesMissing is what's said of each bundle whose files can't be read
// (or found), as tabtopd starts.
func (g *server) bundlesMissing() []string {
	var said []string
	for _, b := range assetBundles {
		dir := b.dir(&g.serverConfig)
		if dir == "" {
			continue
		}
		ok := true
		if b.preload {
			tag, _ := b.set(g).load(g.bundleAssets(b))
			ok = tag != ""
		} else {
			for _, name := range b.names {
				if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
					ok = false
					break
				}
			}
		}
		if !ok {
			said = append(said, "can't read "+b.missing+" (in "+dir+")")
		}
	}
	return said
}
