package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestGoSiteDataInspected lists a site's cookies and localStorage (not
// another site's, nor an expired cookie), each value whole or, past
// maxGoInspectValue, its start (whole characters) with its size; and
// deletes one cookie, and one item, leaving the rest.
func TestGoSiteDataInspected(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	j := newGoCookieJar("", "")
	j.now = func() time.Time { return clock }
	gone := goTestCookie("old", "1", "example.com")
	gone.Expires = 1_700_000_000
	j.apply(nil, goCookieMap(goTestCookie("b", "2", ".example.com"), goTestCookie("a", "1", "shop.example.com"), goTestCookie("c", "3", "other.com"), gone))
	cookies := j.siteCookies("example.com")
	if len(cookies) != 2 || cookies[0].Name != "a" || cookies[1].Name != "b" || cookies[1].Value != "2" || cookies[1].Domain != ".example.com" {
		t.Fatalf("cookies %+v", cookies)
	}
	// As the page's told it: one "value", not two that cancel.
	raw, _ := json.Marshal(cookies[1])
	if !strings.Contains(string(raw), `"value":"2"`) || !strings.Contains(string(raw), `"size":1`) {
		t.Errorf("sent as %s", raw)
	}
	j.forgetOne(goCookieKey{"a", "shop.example.com", "/"})
	if left := j.siteCookies("example.com"); len(left) != 1 || left[0].Name != "b" {
		t.Errorf("after deleting one: %+v", left)
	}

	s := newGoStorage("", nil)
	big := strings.Repeat("é", maxGoInspectValue) // two bytes each: past the most sent
	for _, it := range []struct{ origin, key, value string }{
		{"https://example.com", "theme", "dark"},
		{"https://example.com", "big", big},
		{"https://shop.example.com", "cart", "3"},
		{"https://other.com", "x", "y"},
	} {
		v := it.value
		s.set(it.origin, it.key, &v)
	}
	origins := s.siteItems("example.com")
	if len(origins) != 2 || origins[0].Origin != "https://example.com" || len(origins[0].Items) != 2 || origins[0].Items[1].Key != "theme" {
		t.Fatalf("storage %+v", origins)
	}
	b := origins[0].Items[0]
	if b.Key != "big" || !b.Truncated || b.Size != len(big) || len(b.Value) > maxGoInspectValue || !strings.HasPrefix(big, b.Value) || len(b.Value)%2 != 0 {
		t.Errorf("a big value: %q… %d bytes of %d, truncated %t", b.Value[:4], len(b.Value), b.Size, b.Truncated)
	}
	s.set("https://example.com", "theme", nil)
	if left := s.siteItems("example.com"); len(left[0].Items) != 1 || left[0].Items[0].Key != "big" {
		t.Errorf("after deleting one: %+v", left)
	}
}

// TestGoStorageForgetItemScriptKept: a localStorage item deleted while the
// old restore script can't be removed: no new one's added over it (the old
// one's id lost, and it putting the item back on every load for good).
func TestGoStorageForgetItemScriptKept(t *testing.T) {
	cdp, calls := fakeCDP(t, func(method string, n int) bool { return method == "Page.removeScriptToEvaluateOnNewDocument" })
	b := &goBrowser{ctx: context.Background(), cdp: cdp}
	doc := &goStorageDocument{script: "old", seed: map[string]string{"k": "1", "j": "2"}, base: map[string]string{}}
	b.storageTab.root = t.TempDir()
	b.storageTab.documents = map[string]*goStorageDocument{"https://site.example": doc}
	b.forgetStorageItem("https://site.example", "k")
	close(calls)
	for m := range calls {
		if m == "Page.addScriptToEvaluateOnNewDocument" {
			t.Fatal("a new restore script added, the old one not removed")
		}
	}
	if doc.script != "old" {
		t.Errorf("the old script's id lost: %q", doc.script)
	}
}
