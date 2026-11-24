package main

// The page's notifications (gonotify.js): its Notification.permission, from
// its first script, as its site's answer kept (gosites.go: allow or block;
// unsaid, asked); requestPermission asked of the person (go-notify-ask),
// only soon after their input in the page, as browsers ask, the answer
// kept for the site (a private tab's for the tab alone); and a notification
// it makes passed on to the person's browser (go-notify), named for its
// site, without its icon or image (their browser fetches nothing of the
// page's), its show, click and close told back to the page.
//
// The top page's only: an embedded page of another origin is denied, in
// its own world, as browsers deny it; and a secure page's.

import (
	"context"
	_ "embed"
	"encoding/json"
	"maps"
	"strings"
	"time"
)

//go:embed gonotify.js
var goNotifyJS string

const (
	goNotifyShown   = 16              // a page's notifications shown at once
	goNotifyPerMin  = 10              // shown in a minute, at most
	goNotifyTitle   = 300             // bytes of a title passed on
	goNotifyBody    = 2000            // and of its body
	goNotifyAskWait = 2 * time.Minute // an ask the person hasn't answered
)

// goNotifyOut is what an agent says of the page's notifications: its
// permission asked for, those it showed, and those it closed (by its ids).
type goNotifyOut struct {
	Asks   []string       `json:"asks"`
	Shows  []goNotifyShow `json:"shows"`
	Closes []string       `json:"closes"`
}

type goNotifyShow struct {
	ID                 string `json:"id"`
	Title              string `json:"title"`
	Body               string `json:"body"`
	Tag                string `json:"tag"`
	Silent             bool   `json:"silent"`
	RequireInteraction bool   `json:"requireInteraction"`
	Renotify           bool   `json:"renotify"`
	Dir                string `json:"dir"`
	Lang               string `json:"lang"`
}

// goNotifyAsk is the permission the page asked for, waiting for the person:
// its asks' ids (each answered), for its site.
type goNotifyAsk struct {
	token, site string
	gen, world  int
	ids         []string
	at          time.Time
}

// goNotification is a notification the page showed, by its token.
type goNotification struct {
	gen, world int
	id         string
}

// goNotifyTab is a tab's notifications: the ask waiting, those shown, when
// they were (a minute's), a private tab's answers, and the page's script
// with the answers (its identifier, and the settings' version it has).
type goNotifyTab struct {
	ask     *goNotifyAsk
	shown   map[string]goNotification
	order   []string
	times   []time.Time
	answers map[string]string
	script  string // (the jobs' worker's alone: registered in order there)
	ver     int
	told    bool
}

// notifyState is the page's site's permission: "granted", "denied", or
// "default" (asked).
func (b *goBrowser) notifyState(site string) string {
	answer := b.notifying.answers[site]
	if answer == "" && b.sites != nil {
		answer = b.sites.notificationsFor(site)
	}
	switch answer {
	case "allow":
		return "granted"
	case "block":
		return "denied"
	}
	return "default"
}

// notify acts on what the page in world (of gen) asked of its
// notifications: the top page's only (another origin's frame is denied in
// its own world: what it says is its own doing).
func (b *goBrowser) notify(gen, world int, out goNotifyOut, recent bool) {
	if world != b.world || gen != b.gen {
		return
	}
	n := &b.notifying
	site := goPageSite(b.docURL)
	secure := strings.HasPrefix(goOrigin(b.docURL), "https://") && site != ""
	state := "denied"
	if secure {
		state = b.notifyState(site)
	}
	for _, id := range out.Asks[:min(len(out.Asks), 4)] {
		if !goPasteID.MatchString(id) {
			continue
		}
		if state != "default" || !recent {
			// Answered already, or not after the person's input: told so,
			// not asked (as browsers ask only after a press).
			b.notifyTell(world, map[string]any{"ask": id, "state": state})
			continue
		}
		if a := n.ask; a != nil && a.gen == gen && time.Since(a.at) < goNotifyAskWait {
			if len(a.ids) < 8 {
				a.ids = append(a.ids, id)
			}
			continue
		}
		n.ask = &goNotifyAsk{token: goToken(), site: site, gen: gen, world: world, ids: []string{id}, at: time.Now()}
		goDebugf("notifications: asked for %s", site)
		b.send(map[string]any{"type": "go-notify-ask", "gen": gen, "ask": n.ask.token, "site": site})
	}
	for _, s := range out.Shows[:min(len(out.Shows), 8)] {
		if !goPasteID.MatchString(s.ID) {
			continue
		}
		now := time.Now()
		for len(n.times) > 0 && now.Sub(n.times[0]) > time.Minute {
			n.times = n.times[1:]
		}
		if state != "granted" || len(n.times) >= goNotifyPerMin {
			goDebugf("notifications: one not shown (%s, %d this minute)", state, len(n.times))
			b.notifyTell(world, map[string]any{"id": s.ID, "type": "error"})
			continue
		}
		n.times = append(n.times, now)
		if n.shown == nil {
			n.shown = map[string]goNotification{}
		}
		// The oldest let go, past goNotifyShown.
		for len(n.order) >= goNotifyShown {
			b.notifyClose(n.order[0])
		}
		token := goToken()
		n.shown[token] = goNotification{gen: gen, world: world, id: s.ID}
		n.order = append(n.order, token)
		dir := s.Dir
		if dir != "ltr" && dir != "rtl" {
			dir = "auto"
		}
		goDebugf("notifications: one shown for %s", site)
		b.send(map[string]any{"type": "go-notify", "gen": gen, "ask": token, "site": site,
			"title": goCut(s.Title, goNotifyTitle), "body": goCut(s.Body, goNotifyBody), "tag": goCut(s.Tag, 128),
			"silent": s.Silent, "requireInteraction": s.RequireInteraction, "renotify": s.Renotify, "dir": dir, "lang": goCut(s.Lang, 35)})
	}
	for _, id := range out.Closes {
		for token, s := range n.shown {
			if s.id == id && s.world == world && s.gen == gen {
				b.send(map[string]any{"type": "go-notify-close", "gen": gen, "ask": token})
			}
		}
	}
}

// notifyClose lets one shown go: the person's browser told to close it,
// the page told it closed.
func (b *goBrowser) notifyClose(token string) {
	n := &b.notifying
	if s, ok := n.shown[token]; ok {
		b.send(map[string]any{"type": "go-notify-close", "gen": s.gen, "ask": token})
		if s.gen == b.gen {
			b.notifyTell(s.world, map[string]any{"id": s.id, "type": "close"})
		}
	}
	delete(n.shown, token)
	for i, t := range n.order {
		if t == token {
			n.order = append(n.order[:i], n.order[i+1:]...)
			break
		}
	}
}

// notifyTell gives the agent in world the server's word (gonotify.js).
func (b *goBrowser) notifyTell(world int, m map[string]any) {
	if b.acts.waiting() >= goActsWaiting {
		return
	}
	j, _ := json.Marshal(m)
	b.agentCall(world, "notified", string(j))
}

// notifyAnswer is the person's answer to the page's ask (m.Text, its
// token): m.Value "allow" or "block", kept for its site; or "" (dismissed),
// kept for nothing, the page told it's still to ask.
func (b *goBrowser) notifyAnswer(m goClientMsg) {
	n := &b.notifying
	a := n.ask
	if a == nil || a.token != m.Text {
		return
	}
	n.ask = nil
	if a.gen != b.gen || time.Since(a.at) > goNotifyAskWait {
		return
	}
	if m.Value == "allow" || m.Value == "block" {
		// (A private tab's, for the tab alone: it keeps nothing.)
		kept := false
		if !b.private && b.sites != nil {
			if err := b.sites.set(a.site, "notifications-"+m.Value); err != nil {
				goDebugf("notifications: keeping the answer: %v", err)
			} else {
				kept = true
			}
		}
		if !kept {
			if n.answers == nil {
				n.answers = map[string]string{}
			}
			n.answers[a.site] = m.Value
		}
		goDebugf("notifications: %s for %s", m.Value, a.site)
		b.notifyRegister()
	}
	state := b.notifyState(a.site)
	for _, id := range a.ids {
		b.notifyTell(a.world, map[string]any{"ask": id, "state": state})
	}
}

// notifyEvent passes on what became of a notification shown (m.Text, its
// token) in the person's browser: m.Kind show, click, close or error.
func (b *goBrowser) notifyEvent(m goClientMsg) {
	n := &b.notifying
	s, ok := n.shown[m.Text]
	if !ok || s.gen != b.gen {
		return
	}
	switch m.Kind {
	case "show", "click":
	case "close", "error":
		delete(n.shown, m.Text)
		for i, t := range n.order {
			if t == m.Text {
				n.order = append(n.order[:i], n.order[i+1:]...)
				break
			}
		}
	default:
		return
	}
	b.notifyTell(s.world, map[string]any{"id": s.id, "type": m.Kind})
	if m.Kind == "click" {
		b.afterInput(b.gen) // (as the page's input: it may focus, or open)
	}
}

// notifyGone lets the page's notifications go as it's left: those shown
// closed, its ask let go (the person's browser told).
func (b *goBrowser) notifyGone() {
	n := &b.notifying
	if len(n.shown) == 0 && n.ask == nil {
		return
	}
	b.send(map[string]any{"type": "go-notify-gone"})
	n.shown, n.order, n.ask = nil, nil, nil
}

// notifyAnswers is every site's answer, the settings' and the tab's own.
func (b *goBrowser) notifyAnswers() (map[string]string, int) {
	answers, ver := map[string]string{}, 0
	if b.sites != nil {
		answers, ver = b.sites.notificationsAll()
	}
	maps.Copy(answers, b.notifying.answers)
	return answers, ver
}

// notifyRegister gives every document from now on the answers kept
// (gonotify.js, before the page's own scripts), in place of those it had;
// and the page now its own site's, if it's changed.
func (b *goBrowser) notifyRegister() {
	n := &b.notifying
	answers, ver := b.notifyAnswers()
	n.ver = ver
	j, _ := json.Marshal(answers)
	source := "\n;" + goNotifyJS + "(" + string(j) + ");"
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		if n.script != "" {
			b.cdp.call(ctx, b.page, "Page.removeScriptToEvaluateOnNewDocument", map[string]any{"identifier": n.script}, nil)
			n.script = ""
		}
		var r struct {
			Identifier string `json:"identifier"`
		}
		if err := b.cdp.call(ctx, b.page, "Page.addScriptToEvaluateOnNewDocument", map[string]any{"source": source}, &r); err != nil {
			return err
		}
		n.script = r.Identifier
		return nil
	}, func(r any) {
		if r != nil {
			goDebugf("notifications: the page's script: %v", r)
		}
	})
	if n.told && b.world != 0 && strings.HasPrefix(goOrigin(b.docURL), "https://") {
		if site := goPageSite(b.docURL); site != "" {
			b.notifyTell(b.world, map[string]any{"state": b.notifyState(site)})
		}
	}
	n.told = true
}

// notifySoon registers the answers again if they've changed (Site
// controls, another tab's ask).
func (b *goBrowser) notifySoon() {
	if b.sites == nil {
		return
	}
	if ver := b.sites.notificationsVer(); ver != b.notifying.ver {
		b.notifyRegister()
	}
}
