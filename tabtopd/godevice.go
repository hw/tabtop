package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"time"
)

type goViewerCaps struct {
	Share    bool `json:"share"`
	Location bool `json:"location"`
	PiP      bool `json:"pip"`
}

type goDeviceAsk struct {
	ID      string            `json:"id"`
	Kind    string            `json:"kind"`
	Node    int               `json:"node"`
	Data    map[string]string `json:"data"`
	Options struct {
		High    bool   `json:"enableHighAccuracy"`
		Age     uint32 `json:"maximumAge"`
		Timeout uint32 `json:"timeout"`
	} `json:"options"`
}

type goDevicePending struct {
	id, token, kind string
	gen, world      int
	at              time.Time
}

func (b *goBrowser) devices(gen int, asks []goDeviceAsk) {
	if gen != b.gen || gen != b.shown || b.world == 0 {
		return
	}
	origin := goOrigin(b.docURL)
	for _, a := range asks[:min(len(asks), 4)] {
		if !goPasteID.MatchString(a.ID) || b.acts.waiting() >= goActsWaiting {
			continue
		}
		valid := origin != "" && b.deviceAllowed(a.Kind, origin)
		secure := strings.HasPrefix(origin, "https://")
		reason := "NotAllowedError"
		switch a.Kind {
		case "share":
			valid = valid && secure && b.viewerCaps.Share && b.recentInput(gen, b.world)
			size := 0
			for key, v := range a.Data {
				size += len(v)
				switch key {
				case "title", "text":
				case "url":
					u, err := url.Parse(v)
					valid = valid && err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https")
				default:
					valid = false
				}
			}
			valid = valid && len(a.Data) > 0 && size <= 32<<10
		case "location":
			valid = valid && secure && b.viewerCaps.Location
		case "pip":
			valid = valid && b.viewerCaps.PiP && a.Node > 0 && b.recentInput(gen, b.world)
		case "pip-exit":
			valid = valid && b.pip != nil && b.pip.gen == gen && b.pip.world == b.world
		default:
			valid = false
		}
		if b.device != nil && b.device.gen == gen && time.Since(b.device.at) < goPasteAskFor {
			valid, reason = false, "InvalidStateError"
		}
		if !valid {
			b.agentCall(b.world, "deviceReply", map[string]any{"id": a.ID, "error": reason})
			continue
		}
		b.device = &goDevicePending{a.ID, goToken(), a.Kind, gen, b.world, time.Now()}
		b.send(map[string]any{"type": "go-device", "gen": gen, "ask": b.device.token, "origin": origin, "kind": a.Kind, "node": a.Node, "data": a.Data, "options": a.Options})
	}
}

func (b *goBrowser) deviceAnswer(m goClientMsg) {
	if m.Gen != b.gen || b.shown != b.gen {
		return
	}
	if p := b.pip; p != nil && p.token == m.Text && p.world == b.world && p.gen == b.gen {
		switch m.Kind {
		case "pip-left":
			b.pip = nil
			b.agentCall(p.world, "deviceReply", map[string]any{"left": true})
		case "pip-resize":
			if b.acts.waiting() < goActsWaiting {
				b.agentCall(p.world, "deviceReply", map[string]any{"resize": true, "width": m.FX, "height": m.FY})
			}
		}
		return
	}
	p := b.device
	if p == nil || p.gen != m.Gen || p.token != m.Text || p.world != b.world {
		return
	}
	b.device = nil
	reply := map[string]any{"id": p.id}
	switch {
	case !m.Accept || time.Since(p.at) > goPasteAskFor:
		switch m.Value {
		case "AbortError", "TimeoutError", "NotSupportedError", "InvalidStateError", "PositionUnavailableError":
			reply["error"] = m.Value
		default:
			reply["error"] = "NotAllowedError"
		}
	case p.kind == "location":
		var pos struct {
			Timestamp float64 `json:"timestamp"`
			Coords    struct {
				Latitude, Longitude, Accuracy *float64
			} `json:"coords"`
		}
		if len(m.Value) > 2048 || json.Unmarshal([]byte(m.Value), &pos) != nil || pos.Coords.Latitude == nil || pos.Coords.Longitude == nil || pos.Coords.Accuracy == nil ||
			*pos.Coords.Latitude < -90 || *pos.Coords.Latitude > 90 || *pos.Coords.Longitude < -180 || *pos.Coords.Longitude > 180 || *pos.Coords.Accuracy < 0 {
			reply["error"] = "PositionUnavailableError"
		} else {
			reply["position"] = json.RawMessage(m.Value)
		}
	case p.kind == "pip":
		b.pip = p
		reply["width"], reply["height"] = m.FX, m.FY
	case p.kind == "pip-exit":
		b.pip = nil
		reply["left"] = true
	}
	b.agentCall(p.world, "deviceReply", reply)
}

// The main tunnel accepts small messages. Assemble one user-pasted PNG per tab,
// bound to the original document and target even if focus or navigation changes.
const goPasteImageMax = 8 << 20

type goImagePaste struct {
	gen, world, node, size int
	id                     string
	data                   strings.Builder
	sel                    []int
}

func (b *goBrowser) pasteImage(m goClientMsg) {
	if m.Gen != b.gen || m.Gen != b.shown || b.world == 0 || !goPasteID.MatchString(m.Text) {
		return
	}
	if m.Type == "start" {
		b.imagePaste = nil
		if m.Count <= 0 || m.Count > goPasteImageMax || m.ID <= 0 {
			return
		}
		world, id := b.world, m.ID
		if m.Frame != 0 {
			w, child := b.frameWorldPath(m.ID, m.Route, m.Docs)
			if w == 0 || child == nil || !child.same && m.FDoc != w {
				return
			}
			world, id = w, m.Frame
		}
		b.imagePaste = &goImagePaste{gen: m.Gen, world: world, node: id, size: m.Count, id: m.Text, sel: goSel(m.Sel)}
		return
	}
	p := b.imagePaste
	if p == nil || p.gen != m.Gen || p.id != m.Text {
		return
	}
	if m.Type == "chunk" && len(m.Value) > 0 && len(m.Value) <= 48<<10 && p.data.Len()+len(m.Value) <= base64.StdEncoding.EncodedLen(p.size) {
		p.data.WriteString(m.Value)
		return
	}
	b.imagePaste = nil
	if m.Type != "end" || p.data.Len() != base64.StdEncoding.EncodedLen(p.size) {
		return
	}
	data := p.data.String()
	decoded, err := base64.StdEncoding.Strict().DecodeString(data)
	if err != nil || len(decoded) != p.size || !bytes.HasPrefix(decoded, []byte("\x89PNG\r\n\x1a\n")) {
		return
	}
	if b.imagePasteBusy || b.acts.waiting() >= goActsWaiting {
		b.send(map[string]any{"type": "go-paste-image-error", "gen": b.gen})
		return
	}
	b.imagePasteBusy = true
	b.acts.add(func() {
		ctx, cancel := context.WithTimeout(context.Background(), goActTimeout)
		defer cancel()
		// Evaluate only in the original world. A replacement document may reuse node IDs.
		args, _ := json.Marshal([]any{p.node, data, p.sel})
		var result struct {
			Result struct {
				Value bool `json:"value"`
			} `json:"result"`
		}
		err := b.cdp.call(ctx, b.page, "Runtime.evaluate", map[string]any{
			"contextId": p.world, "returnByValue": true, "expression": "__tabtop.pasteImage(..." + string(args) + ")",
		}, &result)
		b.post(func() {
			b.imagePasteBusy = false
			if b.gen != p.gen {
				return
			}
			if err != nil || !result.Result.Value {
				b.send(map[string]any{"type": "go-paste-image-error", "gen": p.gen})
				return
			}
			b.afterInput(p.gen)
		})
	})
}

// deviceAllowed checks the top document's Permissions-Policy before forwarding
// an operation. The engine's DOM does not expose document.permissionsPolicy.
func (b *goBrowser) deviceAllowed(kind, origin string) bool {
	if b.devicePolicy == "" || goOrigin(b.devicePolicyURL) != origin {
		return true
	}
	var feature string
	switch kind {
	case "pip":
		feature = "picture-in-picture"
	case "share":
		feature = "web-share"
	case "location":
		feature = "geolocation"
	default:
		return true
	}
	for _, directive := range strings.Split(b.devicePolicy, ",") {
		key, value, ok := strings.Cut(directive, "=")
		if !ok || strings.TrimSpace(key) != feature {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "*" {
			continue
		}
		matches := false
		for _, item := range strings.Fields(strings.TrimSuffix(strings.TrimPrefix(value, "("), ")")) {
			if item == "self" || item == `"`+origin+`"` {
				matches = true
			}
		}
		if !matches {
			return false
		}
	}
	return true
}

func (b *goBrowser) releaseDevices() {
	if p := b.device; p != nil && p.gen == b.gen && p.world == b.world {
		b.agentCall(p.world, "deviceReply", map[string]any{"id": p.id, "error": "AbortError"})
	}
	if p := b.pip; p != nil && p.gen == b.gen && p.world == b.world {
		b.agentCall(p.world, "deviceReply", map[string]any{"left": true})
	}
	b.device, b.pip, b.imagePaste = nil, nil, nil
}
