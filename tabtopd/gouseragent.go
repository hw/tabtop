// What the remote browser says it is. A tab's engine says its own (Moli's:
// Chrome on Windows), but on a phone (a touch screen whose shorter side is
// under 600 pixels) it's Chrome on Android, as the person's own browser
// would be, so sites give it what they give phones: its user agent, its
// navigator.platform and its client hints (Sec-CH-UA-Mobile, the platform,
// a model), all one phone's, its Chrome version the engine's own. What the
// server fetches for the page (pictures, fonts, media) says the same; never
// that it's TabTop.

package main

import (
	"context"
	"regexp"
	"strings"
	"sync"
)

// goDesktopUA is said if no engine has said its own yet (a resource asked
// for on a tunnel of its own before any tab opened).
const goDesktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"

var goChromeVersion = regexp.MustCompile(`Chrome/(\d+)((?:\.\d+){3})?`)

// goPhoneProfile is Chrome on an Android phone, at the engine's Chrome
// version (from its own user agent): the user agent as Chrome gives it
// (reduced: "Android 10; K", the version's minor parts 0), and its client
// hints' fuller one.
func goPhoneProfile(engineUA string) (ua string, params map[string]any) {
	major, full := "156", "156.0.0.0"
	if m := goChromeVersion.FindStringSubmatch(engineUA); m != nil {
		major, full = m[1], m[1]+".0.0.0"
		if m[2] != "" {
			full = m[1] + m[2]
		}
	}
	ua = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Mobile Safari/537.36"
	brand := func(v string) []map[string]string {
		return []map[string]string{{"brand": "Chromium", "version": v}, {"brand": "Google Chrome", "version": v}, {"brand": "Not.A/Brand", "version": "99"}}
	}
	fullList := brand(full)
	fullList[2]["version"] = "99.0.0.0"
	return ua, map[string]any{
		"userAgent": ua,
		"platform":  "Linux armv81",
		"userAgentMetadata": map[string]any{
			"brands": brand(major), "fullVersionList": fullList,
			"platform": "Android", "platformVersion": "14.0.0", "architecture": "", "model": "Pixel 8", "mobile": true,
		},
	}
}

// goPhone is whether a view is a phone's: a touch screen, its shorter side
// under 600 pixels (a tablet's, larger, says Chrome on its own platform).
func goPhone(v goView) bool {
	return v.Touch && min(v.SW, v.SH) > 0 && min(v.SW, v.SH) < 600
}

// goSessionUAs is what each session's tabs last said they are, for what's
// fetched for them on a tunnel of their own (no tab to ask).
var goSessionUAs = struct {
	sync.Mutex
	by      map[string]string
	desktop string // an engine's own, once one's said it
}{by: map[string]string{}}

func goSessionUA(session string) string {
	goSessionUAs.Lock()
	defer goSessionUAs.Unlock()
	if ua := goSessionUAs.by[session]; ua != "" {
		return ua
	}
	if goSessionUAs.desktop != "" {
		return goSessionUAs.desktop
	}
	return goDesktopUA
}

func goRememberUA(session, ua string) {
	goSessionUAs.Lock()
	defer goSessionUAs.Unlock()
	if len(goSessionUAs.by) > 1000 {
		clear(goSessionUAs.by)
	}
	goSessionUAs.by[session] = ua
}

// startUA learns the engine's own user agent, which the tab says till it's
// a phone's.
func (b *goBrowser) startUA(ctx context.Context) {
	var r struct {
		UserAgent string `json:"userAgent"`
	}
	if err := b.cdp.call(ctx, "", "Browser.getVersion", nil, &r); err == nil && strings.HasPrefix(r.UserAgent, "Mozilla/") {
		b.engineUA = r.UserAgent
		goSessionUAs.Lock()
		if goSessionUAs.desktop == "" && !strings.Contains(r.UserAgent, "Mobile") {
			goSessionUAs.desktop = r.UserAgent
		}
		goSessionUAs.Unlock()
	}
	if b.engineUA == "" {
		b.engineUA = goDesktopUA
	}
	b.setUA(b.engineUA)
}

func (b *goBrowser) setUA(ua string) {
	b.uaMu.Lock()
	b.userAgent = ua
	b.uaMu.Unlock()
	goRememberUA(b.session, ua)
}

// ua is what the tab says it is now.
func (b *goBrowser) ua() string {
	b.uaMu.Lock()
	defer b.uaMu.Unlock()
	if b.userAgent == "" {
		return goSessionUA(b.session)
	}
	return b.userAgent
}

// phoneUA has the engine say it's Chrome on an Android phone, from now on
// (a job: before what's loaded next). Once: a tab's device doesn't change.
func (b *goBrowser) phoneUA(ctx context.Context) {
	if b.phone {
		return
	}
	ua, params := goPhoneProfile(b.engineUA)
	if err := b.cdp.call(ctx, b.page, "Emulation.setUserAgentOverride", params, nil); err != nil {
		goDebugf("user agent: %v", err)
		return
	}
	b.phone = true
	b.setUA(ua)
	goDebugf("user agent: a phone's")
}
