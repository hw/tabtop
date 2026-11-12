package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestEpubPictureUsesBig: an illustrated book, 2,000 pages each showing
// a picture of its own, is reported on, and trimmed, in good time.
func TestEpubPictureUsesBig(t *testing.T) {
	const n = 2000
	var items strings.Builder
	files := []string{}
	items.WriteString(`<item id="cov" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`)
	for i := range n {
		fmt.Fprintf(&items, `<item id="p%d" href="text/p%d.xhtml" media-type="application/xhtml+xml"/><item id="i%d" href="images/pic-%d.png" media-type="image/png"/>`, i, i, i, i)
		files = append(files, fmt.Sprintf("OEBPS/text/p%d.xhtml", i),
			fmt.Sprintf(`<html><body><p>%s</p><img src="../images/pic-%d.png"/></body></html>`, strings.Repeat("Words on the page. ", 100), i),
			fmt.Sprintf("OEBPS/images/pic-%d.png", i), "P")
	}
	items.WriteString(`<item id="spare" href="images/spare.png" media-type="image/png"/>`)
	files = append(files, "OEBPS/cover.jpg", "J", "OEBPS/images/spare.png", "S")
	book := makeEpub(t, editBookFiles(editOPF("3.0", `<dc:title>T</dc:title>`, items.String()), files...)...)
	start := time.Now()
	uses, err := openTestEpub(t, book).pictureReport()
	report := time.Since(start)
	if err != nil || len(uses) != n+2 {
		t.Fatalf("%d pictures, %v", len(uses), err)
	}
	start = time.Now()
	trimmed(t, book, epubEdit{Title: "T", RemoveItems: []string{"OEBPS/images/spare.png"}}, nil)
	trim := time.Since(start)
	t.Logf("report %v, trim %v", report, trim)
	if report > 5*time.Second || trim > 10*time.Second {
		t.Errorf("too slow: report %v, trim %v", report, trim)
	}
}
