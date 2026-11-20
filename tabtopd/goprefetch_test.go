package main

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// What a stylesheet uses is read as the page shown fetches it: imports as
// stylesheets, any url() and image-set()'s strings but a @font-face's as
// pictures (fonts are asked for as they're used); a fragment (an SVG's own)
// isn't one.
func TestGoCSSWants(t *testing.T) {
	css := `@import url("more.css") screen; @import 'other.css';
@font-face { font-family: X; src: url(font.woff2) format("woff2"), url('font.ttf'); }
body { background: url(bg.png); } .a { mask: url(#m); } .b { background-image: image-set("x1.png" 1x, 'x2.png' 2x); }
.c { background: url( "spaced.png" ) }`
	var got []string
	for _, w := range goCSSWants(css) {
		got = append(got, w.kind+" "+w.url)
	}
	want := []string{"css more.css", "css other.css", "image bg.png", "image spaced.png", "image x1.png", "image x2.png"}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestGoResolve(t *testing.T) {
	for _, c := range []struct{ raw, base, want string }{
		{"a.png", "https://x.example/css/s.css", "https://x.example/css/a.png"},
		{"/a.png#frag", "https://x.example/css/s.css", "https://x.example/a.png"},
		{"//cdn.example/f.woff2", "https://x.example/", "https://cdn.example/f.woff2"},
		{"data:image/png;base64,AAAA", "https://x.example/", ""},
		{"javascript:alert(1)", "https://x.example/", ""},
		{"ftp://x.example/a", "https://x.example/", ""},
		{"  ", "https://x.example/", ""},
	} {
		if got := goResolve(c.raw, c.base); got != c.want {
			t.Errorf("%q against %q: %q, want %q", c.raw, c.base, got, c.want)
		}
	}
}

// A tab's cache fetches each resource once, however many ask together;
// keeps no failure; and drops the oldest once it holds too much.
func TestGoResCache(t *testing.T) {
	c := newGoResCache()
	var fetches atomic.Int32
	slow := func() goFetched {
		fetches.Add(1)
		time.Sleep(50 * time.Millisecond)
		return goFetched{data: []byte("bytes")}
	}
	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if f := c.get(context.Background(), "image a", slow); string(f.data) != "bytes" {
				t.Errorf("got %q", f.data)
			}
		}()
	}
	wg.Wait()
	if n := fetches.Load(); n != 1 {
		t.Errorf("fetched %d times", n)
	}
	failing := func() goFetched { fetches.Add(1); return goFetched{err: errors.New("no")} }
	c.get(context.Background(), "image b", failing)
	c.get(context.Background(), "image b", failing)
	if n := fetches.Load(); n != 3 || c.has("image b") {
		t.Errorf("a failure was kept (%d fetches)", n)
	}
	big := make([]byte, goResCacheMax/2+1)
	c.get(context.Background(), "image big1", func() goFetched { return goFetched{data: big} })
	c.get(context.Background(), "image big2", func() goFetched { return goFetched{data: big} })
	if c.has("image a") || c.has("image big1") || !c.has("image big2") || c.bytes > goResCacheMax {
		t.Errorf("kept a %v, big1 %v, big2 %v, %d bytes", c.has("image a"), c.has("image big1"), c.has("image big2"), c.bytes)
	}
	// One that gives up waiting isn't left with nothing to say.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	go c.get(context.Background(), "image slow", func() goFetched { time.Sleep(200 * time.Millisecond); return goFetched{data: []byte("x")} })
	time.Sleep(5 * time.Millisecond)
	if f := c.get(ctx, "image slow", slow); f.err == nil {
		t.Error("waited past its deadline")
	}
}

// A page gets at most goPrefetchMax resources fetched ahead, whatever its
// stylesheets ask for, none it has already, and none once it's left.
func TestGoPrefetcherLimits(t *testing.T) {
	b := &goBrowser{res: newGoResCache()}
	ctx, cancel := context.WithCancel(context.Background())
	p := &goPrefetcher{ctx: ctx, cancel: cancel, queue: make(chan goPrefetch, goPrefetchMax)}
	b.res.get(context.Background(), "image https://x.example/had.png", func() goFetched { return goFetched{data: []byte("x")} })
	p.want(b, goWanted{"image", "https://x.example/had.png"}, 0)
	if len(p.queue) != 0 {
		t.Error("queued one it had")
	}
	for i := range goPrefetchMax + 100 {
		p.want(b, goWanted{"image", "https://x.example/" + strconv.Itoa(i) + ".png"}, 1)
	}
	if n := len(p.queue); n != goPrefetchMax {
		t.Errorf("queued %d", n)
	}
	cancel()
	for len(p.queue) > 0 {
		<-p.queue
	}
	p.count.Store(0)
	p.want(b, goWanted{"image", "https://x.example/after.png"}, 0)
	if len(p.queue) != 0 {
		t.Error("queued one after the page was left")
	}
}
