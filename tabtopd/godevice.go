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
	Share bool `json:"share"`
	// ShareFiles: its share sheet takes files too (canShare({files})).
	ShareFiles bool `json:"shareFiles"`
	Location   bool `json:"location"`
	PiP        bool `json:"pip"`
	FileSystem bool `json:"fileSystem"`
	// WakeLock: it can keep its screen on (gowakelock.go).
	WakeLock bool `json:"wakeLock"`
	// Orientation: it can lock its screen's orientation (goorientation.go).
	Orientation bool `json:"orientation"`
	// PointerLock: it can lock its pointer (gopointerlock.go).
	PointerLock bool `json:"pointerLock"`
}

// goShareFile is a file the page shares (navigator.share({files})): its
// bytes relayed to the person's browser as a file stream of its own
// (gomedia.js), named here.
type goShareFile struct {
	Stream int    `json:"stream"`
	Name   string `json:"name"`
	Type   string `json:"type"`
	Size   int64  `json:"size"`
}

const (
	goShareFiles     = 10        // files shared at once, at most
	goShareFileBytes = 100 << 20 // and their bytes
)

type goDeviceAsk struct {
	ID      string            `json:"id"`
	Kind    string            `json:"kind"`
	Node    int               `json:"node"`
	Data    map[string]string `json:"data"`
	Files   []goShareFile     `json:"files"`
	FS      *goFSRequest      `json:"fs,omitempty"`
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
	// So many asks a read, as the agent sends them (goagent.js): 4, and 16
	// pieces of saved files.
	others, writes := 0, 0
	for _, a := range asks[:min(len(asks), 4+16)] {
		if a.Kind == "fs-write" {
			writes++
		} else {
			others++
		}
		if writes > 16 || others > 4 || !goPasteID.MatchString(a.ID) || b.acts.waiting() >= goActsWaiting {
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
			// Its files: so many, so large, named as they can be saved.
			var total int64
			for i, f := range a.Files {
				total += f.Size
				name := cleanFetchName(f.Name)
				valid = valid && f.Stream > 0 && f.Size >= 0 && name != "" && len(f.Type) <= 128 && !strings.ContainsAny(f.Type, "\r\n")
				a.Files[i].Name = name
			}
			valid = valid && (len(a.Files) == 0 || b.viewerCaps.ShareFiles) && len(a.Files) <= goShareFiles && total <= goShareFileBytes
			valid = valid && (len(a.Data) > 0 || len(a.Files) > 0) && size <= 32<<10
		case "location", "location-watch":
			valid = valid && secure && b.viewerCaps.Location
		case "location-stop":
			valid = valid && b.locWatch != nil && b.locWatch.gen == gen && b.locWatch.world == b.world
		case "pip":
			valid = valid && b.viewerCaps.PiP && a.Node > 0 && b.recentInput(gen, b.world)
		case "pip-exit":
			valid = valid && b.pip != nil && b.pip.gen == gen && b.pip.world == b.world
		case "fs-open", "fs-save":
			valid = valid && secure && b.viewerCaps.FileSystem && b.recentInput(gen, b.world) && validGoFSAsk(a.Kind, a.FS)
		case "fs-read":
			valid = valid && secure && b.viewerCaps.FileSystem && validGoFSAsk(a.Kind, a.FS)
		case "fs-begin", "fs-write", "fs-close", "fs-abort", "fs-truncate":
			// Only a save destination's written: not a file opened to read.
			valid = valid && secure && b.viewerCaps.FileSystem && validGoFSAsk(a.Kind, a.FS) && b.fsWritable(a.FS.Handle, gen, b.world)
		default:
			valid = false
		}
		if a.Kind == "fs-write" && valid {
			b.fsWrite(gen, origin, a) // (many at once, not the one ask)
			// The page's next pieces read sooner than the poll's 250 ms.
			if b.readSoon == nil {
				b.readSoon = time.After(goChangesEvery)
			}
			continue
		}
		if b.device != nil && b.device.gen == gen && time.Since(b.device.at) < goPasteAskFor {
			valid, reason = false, "InvalidStateError"
		}
		if !valid {
			b.agentCall(b.world, "deviceReply", map[string]any{"id": a.ID, "error": reason})
			continue
		}
		if a.Kind == "fs-read" {
			b.fsReadRequest(gen, b.world, a.ID, a.FS)
			continue
		}
		if a.Kind == "fs-close" {
			b.fsWritten(a.FS.Handle)
		}
		b.device = &goDevicePending{a.ID, goToken(), a.Kind, gen, b.world, time.Now()}
		b.send(map[string]any{"type": "go-device", "gen": gen, "ask": b.device.token, "origin": origin, "kind": a.Kind, "node": a.Node, "data": a.Data, "files": a.Files, "options": a.Options, "fs": a.FS})
	}
}

func (b *goBrowser) deviceAnswer(m goClientMsg) {
	if m.Gen != b.gen || b.shown != b.gen {
		return
	}
	// A position followed (watchPosition), or an error of it: to the page,
	// so often at most (goLocationEvery).
	if w := b.locWatch; w != nil && w.token == m.Text && w.world == b.world && w.gen == b.gen {
		switch m.Kind {
		case "location-update":
			if time.Since(b.locWatchAt) < goLocationEvery {
				return
			}
			if position, ok := goPositionOf(m.Value); ok {
				b.locWatchAt = time.Now()
				b.agentCall(w.world, "deviceReply", map[string]any{"watch": true, "position": position})
			}
		case "location-error":
			reply := map[string]any{"watch": true, "error": goLocationError(m.Value)}
			if reply["error"] == "NotAllowedError" {
				b.locWatch = nil
				reply["ended"] = true
			}
			b.agentCall(w.world, "deviceReply", reply)
		case "location-ended":
			// Stopped by the person (its bar's Stop): the page's watchers end.
			b.locWatch = nil
			b.agentCall(w.world, "deviceReply", map[string]any{"watch": true, "error": "NotAllowedError", "ended": true})
		}
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
	if b.fsWriteAnswer(m) {
		return // a saved file's piece (gofs.go)
	}
	p := b.device
	if p == nil || p.gen != m.Gen || p.token != m.Text || p.world != b.world {
		return
	}
	b.device = nil
	reply := map[string]any{"id": p.id}
	switch {
	case !m.Accept || time.Since(p.at) > goPasteAskFor:
		reply["error"] = goDeviceError(m.Value)
	case p.kind == "location" || p.kind == "location-watch":
		if position, ok := goPositionOf(m.Value); !ok {
			reply["error"] = "PositionUnavailableError"
		} else {
			reply["position"] = position
			if p.kind == "location-watch" {
				b.locWatch, b.locWatchAt = p, time.Now() // its positions to come (above)
			}
		}
	case p.kind == "location-stop":
		b.locWatch = nil
		reply["stopped"] = true
	case p.kind == "pip":
		b.pip = p
		reply["width"], reply["height"] = m.FX, m.FY
	case p.kind == "pip-exit":
		b.pip = nil
		reply["left"] = true
	case strings.HasPrefix(p.kind, "fs-"):
		fields, why := validateGoFSReply(p.kind, m.Value)
		if why != "" {
			reply["error"] = why
		} else if (p.kind == "fs-open" || p.kind == "fs-save") && !b.rememberFSHandles(p.kind, m.Value, p.gen, p.world) {
			reply["error"] = "DataError"
		}
		for key, value := range fields {
			reply[key] = value
		}
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
	case "location", "location-watch":
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

// deviceRegister gives every document from now on what the person's
// browser can do (godevice.js, before the page's own scripts), in place of
// what it was given: a tab taken back by another browser (a phone's, with
// a share sheet) has its pages told what that one can.
func (b *goBrowser) deviceRegister() {
	caps, _ := json.Marshal(b.viewerCaps)
	source := "\n;" + goDeviceJS + "(" + string(caps) + ");"
	b.job(func() any {
		ctx, cancel := context.WithTimeout(context.Background(), goCallTimeout)
		defer cancel()
		if b.deviceScript != "" {
			b.cdp.call(ctx, b.page, "Page.removeScriptToEvaluateOnNewDocument", map[string]any{"identifier": b.deviceScript}, nil)
			b.deviceScript = ""
		}
		var r struct {
			Identifier string `json:"identifier"`
		}
		if err := b.cdp.call(ctx, b.page, "Page.addScriptToEvaluateOnNewDocument", map[string]any{"source": source}, &r); err != nil {
			return err
		}
		b.deviceScript = r.Identifier
		return nil
	}, func(r any) {
		if r != nil {
			goDebugf("devices: the page's script: %v", r)
		}
	})
}

// viewerChanged takes what a browser taking the tab back can do: its pages
// from now on told (deviceRegister), the page shown on its next load.
func (b *goBrowser) viewerChanged(caps goViewerCaps) {
	if caps == b.viewerCaps {
		return
	}
	b.viewerCaps = caps
	b.deviceRegister()
}

// goLocationEvery is how often at most a followed position is passed on
// (the person's browser sends one each 250 ms at most, the newest: this
// only bounds one that doesn't).
const goLocationEvery = 100 * time.Millisecond

// goPositionOf is the position the person's browser said, if it's one.
func goPositionOf(value string) (json.RawMessage, bool) {
	var pos struct {
		Timestamp float64 `json:"timestamp"`
		Coords    struct {
			Latitude, Longitude, Accuracy *float64
		} `json:"coords"`
	}
	if len(value) > 2048 || json.Unmarshal([]byte(value), &pos) != nil || pos.Coords.Latitude == nil || pos.Coords.Longitude == nil || pos.Coords.Accuracy == nil ||
		*pos.Coords.Latitude < -90 || *pos.Coords.Latitude > 90 || *pos.Coords.Longitude < -180 || *pos.Coords.Longitude > 180 || *pos.Coords.Accuracy < 0 {
		return nil, false
	}
	return json.RawMessage(value), true
}

// goLocationError is a position's error, as the page's is named.
func goLocationError(value string) string {
	switch value {
	case "NotAllowedError", "TimeoutError":
		return value
	}
	return "PositionUnavailableError"
}

func (b *goBrowser) releaseDevices() {
	if p := b.device; p != nil && p.gen == b.gen && p.world == b.world {
		b.agentCall(p.world, "deviceReply", map[string]any{"id": p.id, "error": "AbortError"})
	}
	if p := b.pip; p != nil && p.gen == b.gen && p.world == b.world {
		b.agentCall(p.world, "deviceReply", map[string]any{"left": true})
	}
	if w := b.locWatch; w != nil && w.gen == b.gen && w.world == b.world {
		b.agentCall(w.world, "deviceReply", map[string]any{"watch": true, "ended": true})
	}
	b.device, b.pip, b.imagePaste, b.locWatch = nil, nil, nil, nil
	b.resetFileSystem()
	// The person's browser's pointer lock and screen orientation lock went
	// with it (the page told it's left); its wake lock is taken again by
	// the next that connects (wakeLockAgain).
	b.pointerLockLost()
	b.orientAsks, b.orientLocked = nil, false
}

// goDeviceError is the error the person's browser said, as the page's
// DOMException's name: one of those it can say, else NotAllowedError.
func goDeviceError(name string) string {
	switch name {
	case "AbortError", "TimeoutError", "NotSupportedError", "InvalidStateError", "PositionUnavailableError", "DataError", "TypeError", "SecurityError", "NotFoundError", "NotReadableError", "QuotaExceededError":
		return name
	}
	return "NotAllowedError"
}
