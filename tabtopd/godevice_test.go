package main

import (
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Moli's data: fixture is offline. Supply the secure-context flag to the
// site shim, then exercise the real DOM, including the agent's node IDs.
func TestGoViewerDeviceAPIsWithMoli(t *testing.T) {
	moli := os.Getenv("TABTOP_TEST_MOLI")
	if moli == "" {
		t.Skip("TABTOP_TEST_MOLI isn't set")
	}
	script := "const install = isSecureContext => " + goDeviceJS +
		"; install(true)({share:true,location:true,pip:true});\n" + goAgentJS + `;
        (async () => {
            const v = document.querySelector("video"), events = [];
            const next = () => JSON.parse(__tabtop.changes()).devices[0];
            v.onenterpictureinpicture = () => events.push("enter");
            v.onleavepictureinpicture = () => events.push("leave");
            const share = navigator.share({url:"https://example.com/link"});
            let r = next();
            __tabtop.deviceReply({id:r.id,error:"AbortError"});
            try { await share; } catch(e) { events.push(e.name); }
            const geo = new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok,no));
            r = next();
            __tabtop.deviceReply({id:r.id,position:{coords:{latitude:0}}});
            events.push((await geo).coords.latitude);
            const enter = v.requestPictureInPicture(), node = (r = next()).node;
            __tabtop.deviceReply({id:r.id,width:10,height:20});
            const win = await enter;
            win.onresize = () => events.push(win.width);
            __tabtop.deviceReply({resize:true,width:30,height:20});
            const exit = document.exitPictureInPicture();
            __tabtop.deviceReply({id:next().id,left:true});
            await exit;
            let file;
            document.addEventListener("paste", e => {
                e.preventDefault();
                file = e.clipboardData.items[0].getAsFile();
                events.push(e.target === v, file.type, file.name);
            }, {once:true});
            __tabtop.pasteImage(node, "iVBORw0KGgo=");
            const editor = document.querySelector("div");
            editor.focus();
            const find = n => n.n === "div" ? n : n.c?.map(find).find(Boolean);
            const ed = find(JSON.parse(__tabtop.snapshot()).doc);
            __tabtop.pasteImage(ed.i, "iVBORw0KGgo=", [ed.i, 0, ed.i, 0]);
            return [...events, (await file.arrayBuffer()).byteLength, document.pictureInPictureElement, !!editor.querySelector("img")];
        })()`
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, moli, "fetch", "data:text/html,<video></video><div contenteditable=true></div>", "--eval-file", "-")
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Moli: %v: %s", err, out)
	}
	want := `["AbortError",0,"enter",30,"leave",true,"image/png","image.png",8,null,true]`
	if strings.TrimSpace(string(out)) != want {
		t.Fatalf("page got %s; want %s", out, want)
	}
}

func TestGoDeviceOriginAndGesture(t *testing.T) {
	b, w := goClipTab()
	b.viewerCaps = goViewerCaps{Share: true, Location: true, PiP: true}
	req := goDeviceAsk{ID: "a", Kind: "share", Data: map[string]string{"url": "https://example.net/"}}
	b.devices(1, []goDeviceAsk{req})
	if b.device != nil {
		t.Fatal("share accepted without a gesture")
	}
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	b.devicePolicyURL, b.devicePolicy = b.docURL, "web-share=(), geolocation=(self)"
	b.devices(1, []goDeviceAsk{req})
	if b.device != nil {
		t.Fatal("site policy ignored")
	}
	b.devicePolicy = ""
	b.devices(1, []goDeviceAsk{req})
	messages := goSentOf(w, "go-device")
	if len(messages) != 1 || messages[0]["origin"] != "https://www.example.com" {
		t.Fatalf("wrong prompt: %v", messages)
	}
	token := b.device.token
	for _, reply := range []goClientMsg{{Gen: 2, Text: token}, {Gen: 1, Text: "wrong"}} {
		b.deviceAnswer(reply)
		if b.device == nil {
			t.Fatal("stale response consumed request")
		}
	}
	b.deviceAnswer(goClientMsg{Gen: 1, Text: token, Accept: true})
	if b.device != nil {
		t.Fatal("request retained after completion")
	}
	b.inputGen = 0
	b.devices(1, []goDeviceAsk{{ID: "position", Kind: "location"}})
	if b.device == nil {
		t.Fatal("one-shot location did not ask permission")
	}
	b.connLost()
	if b.device != nil {
		t.Fatal("detached viewer retained its pending request")
	}
}

func TestGoPastedImageBoundToDocument(t *testing.T) {
	b, _ := goClipTab()
	start := goClientMsg{Gen: 1, Type: "start", Text: "png", ID: 9, Frame: 3, FDoc: 7, Count: 8}
	b.pasteImage(start)
	if b.imagePaste == nil || b.imagePaste.world != 7 || b.imagePaste.node != 3 {
		t.Fatal("wrong frame target")
	}
	chunk := goClientMsg{Gen: 1, Type: "chunk", Text: "png", Value: "iVBORw0KGgo="}
	b.pasteImage(chunk)
	end := goClientMsg{Gen: 1, Type: "end", Text: "png"}
	b.pasteImage(end)
	b.pasteImage(end)
	if b.imagePaste != nil || b.acts.waiting() != 1 {
		t.Fatal("PNG was not delivered exactly once")
	}
	start.FDoc = 8
	b.pasteImage(start)
	if b.imagePaste != nil {
		t.Fatal("stale child document accepted")
	}
	start.FDoc = 7
	start.Count = goPasteImageMax + 1
	b.pasteImage(start)
	if b.imagePaste != nil {
		t.Fatal("oversized image accepted")
	}
}

func TestGoDeviceAsset(t *testing.T) {
	w := httptest.NewRecorder()
	(&server{goOn: true}).goPage(w, httptest.NewRequest("GET", goPrefix+"go-device.js", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "export function viewerDevices") {
		t.Fatal("missing viewer module", w.Code)
	}
}

// TestGoLocationWatch: a followed position, allowed, has its first given as
// its answer and the rest as they come (so often at most); an error that
// ends it, the page's stop, or the page left, ends it.
func TestGoLocationWatch(t *testing.T) {
	b, _ := goClipTab()
	b.viewerCaps = goViewerCaps{Location: true}
	pos := `{"coords":{"latitude":1,"longitude":2,"accuracy":3},"timestamp":5}`
	b.devices(1, []goDeviceAsk{{ID: "w1", Kind: "location-watch"}})
	if b.device == nil || b.device.kind != "location-watch" {
		t.Fatal("not asked")
	}
	token := b.device.token
	b.deviceAnswer(goClientMsg{Gen: 1, Text: token, Accept: true, Value: pos})
	if b.locWatch == nil || b.acts.waiting() != 1 {
		t.Fatalf("not followed (%v), or its first not given", b.locWatch)
	}
	update := goClientMsg{Gen: 1, Text: token, Kind: "location-update", Value: pos}
	b.deviceAnswer(update) // (too soon: dropped)
	b.locWatchAt = time.Now().Add(-time.Second)
	b.deviceAnswer(update)
	b.deviceAnswer(goClientMsg{Gen: 1, Text: token, Kind: "location-update", Value: `{"coords":{"latitude":91}}`})
	if b.acts.waiting() != 2 {
		t.Errorf("%d given (one more, not the one too soon nor the bad one)", b.acts.waiting())
	}
	b.deviceAnswer(goClientMsg{Gen: 1, Text: "other", Kind: "location-update", Value: pos})
	b.deviceAnswer(goClientMsg{Gen: 1, Text: token, Kind: "location-error", Value: "TimeoutError"})
	if b.locWatch == nil || b.acts.waiting() != 3 {
		t.Errorf("a time-out ended it, or another's update was given")
	}
	// Stopped by the page.
	b.devices(1, []goDeviceAsk{{ID: "s1", Kind: "location-stop"}})
	if b.device == nil || b.device.kind != "location-stop" {
		t.Fatal("its stop not passed on")
	}
	b.deviceAnswer(goClientMsg{Gen: 1, Text: b.device.token, Accept: true})
	if b.locWatch != nil {
		t.Error("followed after its stop")
	}
	// A stop with nothing followed: refused.
	before := b.acts.waiting()
	b.devices(1, []goDeviceAsk{{ID: "s2", Kind: "location-stop"}})
	if b.device != nil || b.acts.waiting() != before+1 {
		t.Error("a stop of nothing passed on")
	}
	// Followed again, then the page left: ended, the page told.
	b.devices(1, []goDeviceAsk{{ID: "w2", Kind: "location-watch"}})
	b.deviceAnswer(goClientMsg{Gen: 1, Text: b.device.token, Accept: true, Value: pos})
	b.connLost()
	if b.locWatch != nil {
		t.Error("followed after its page was left")
	}
}

// TestGoShareFiles: files shared only where the person's browser shares
// them, so many and so large, named as they can be saved; passed on with
// the ask.
func TestGoShareFiles(t *testing.T) {
	b, w := goClipTab()
	b.inputAt, b.inputGen, b.inputWorld = time.Now(), 1, 1
	ask := func(files []goShareFile) bool {
		b.device = nil
		b.devices(1, []goDeviceAsk{{ID: "s", Kind: "share", Files: files}})
		return b.device != nil
	}
	file := goShareFile{Stream: 4, Name: "../notes/report.csv", Type: "text/csv", Size: 10}
	b.viewerCaps = goViewerCaps{Share: true}
	if ask([]goShareFile{file}) {
		t.Error("files shared where the browser shares none")
	}
	b.viewerCaps.ShareFiles = true
	if !ask([]goShareFile{file}) {
		t.Fatal("a file not shared")
	}
	got := goSentOf(w, "go-device")
	files, _ := got[len(got)-1]["files"].([]any)
	if len(files) != 1 || files[0].(map[string]any)["name"] != "report.csv" {
		t.Errorf("passed on %v", got[len(got)-1]["files"])
	}
	many := make([]goShareFile, goShareFiles+1)
	for i := range many {
		many[i] = goShareFile{Stream: i + 1, Name: "a.txt", Size: 1}
	}
	for _, bad := range [][]goShareFile{many, {{Stream: 1, Name: "big.bin", Size: goShareFileBytes + 1}}, {{Stream: 0, Name: "a.txt"}}, {{Stream: 1, Name: "..."}}} {
		if ask(bad) {
			t.Errorf("shared %d files, the first %+v", len(bad), bad[0])
		}
	}
}

// TestGoViewerChanged: a tab taken back by a browser that can do otherwise
// has its pages told anew (the script registered again); the same, not.
func TestGoViewerChanged(t *testing.T) {
	b, _ := goClipTab()
	b.jobs = newGoQueue()
	b.viewerCaps = goViewerCaps{Location: true}
	b.viewerChanged(goViewerCaps{Location: true})
	if b.jobs.waiting() != 0 {
		t.Error("registered again for the same")
	}
	b.viewerChanged(goViewerCaps{Location: true, Share: true, ShareFiles: true})
	if !b.viewerCaps.ShareFiles || b.jobs.waiting() != 1 {
		t.Errorf("not taken: %+v, %d jobs", b.viewerCaps, b.jobs.waiting())
	}
}
