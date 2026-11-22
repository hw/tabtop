package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/coder/websocket"
)

// cookieEngine is an engine's CDP endpoint keeping cookies: its
// Network.getAllCookies says them, Network.deleteCookies takes one away.
type cookieEngine struct {
	mu      sync.Mutex
	cookies []goCookie
}

func (e *cookieEngine) set(c goCookie) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cookies = append(e.cookies, c)
}

func (e *cookieEngine) conn(t *testing.T) *cdpConn {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			_, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			var m struct {
				ID     int64  `json:"id"`
				Method string `json:"method"`
				Params struct {
					Name, Domain, Path string
				} `json:"params"`
			}
			json.Unmarshal(b, &m)
			result := "{}"
			e.mu.Lock()
			switch m.Method {
			case "Network.getAllCookies":
				out, _ := json.Marshal(map[string]any{"cookies": e.cookies})
				result = string(out)
			case "Network.deleteCookies":
				kept := e.cookies[:0]
				for _, ck := range e.cookies {
					if ck.Name != m.Params.Name || ck.Domain != m.Params.Domain || ck.Path != m.Params.Path {
						kept = append(kept, ck)
					}
				}
				e.cookies = kept
			}
			e.mu.Unlock()
			c.Write(r.Context(), websocket.MessageText, fmt.Appendf(nil, `{"id":%d,"result":%s}`, m.ID, result))
		}
	}))
	t.Cleanup(srv.Close)
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &cdpConn{ws: ws, pending: map[int64]chan cdpMessage{}, Events: make(chan cdpEvent, 8), done: make(chan struct{})}
	go c.read()
	t.Cleanup(func() { ws.CloseNow() })
	return c
}

// TestGoForgetCookieKeepsOthers: a cookie deleted in Site data while a tab
// has set another since it last synced: the other's kept in the jar at the
// tab's next sync (it was lost: the tab's base taken as the engine's now).
func TestGoForgetCookieKeepsOthers(t *testing.T) {
	engine := &cookieEngine{}
	engine.set(goCookie{Name: "keep", Value: "1", Domain: "example.com", Path: "/", Expires: -1, Session: true})
	engine.set(goCookie{Name: "gone", Value: "1", Domain: "example.com", Path: "/", Expires: -1, Session: true})
	jar := newGoCookieJar("", "")
	b := &goBrowser{cdp: engine.conn(t), jar: jar}
	b.cookies.started = true
	jar.addTab(b)
	b.syncCookies()
	if _, ok := jar.lookup(goCookieKey{"gone", "example.com", "/"}); !ok {
		t.Fatal("the tab's cookies not synced")
	}
	// The page logs in (a cookie set), then Site data deletes another.
	engine.set(goCookie{Name: "session", Value: "abc", Domain: "example.com", Path: "/", Expires: -1, Session: true})
	jar.forgetOne(goCookieKey{"gone", "example.com", "/"})
	b.syncCookies()
	if c, ok := jar.lookup(goCookieKey{"session", "example.com", "/"}); !ok || c.Value != "abc" {
		t.Error("a cookie the tab set before another was deleted wasn't kept")
	}
	if _, ok := jar.lookup(goCookieKey{"gone", "example.com", "/"}); ok {
		t.Error("the deleted cookie kept")
	}
}
