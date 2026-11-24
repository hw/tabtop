package main

// Save of a clear Media Source stream: the viewer spills completed MP4
// pieces to a staging folder during playback (mse-capture.js), then
// finalizes into Downloads as Save stream remuxes HLS/DASH (gosavestream.go).

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Eyevinn/mp4ff/bits"
	"github.com/Eyevinn/mp4ff/mp4"
	"github.com/coder/websocket"
)

// What buffered streams may stage, so tabs can't fill the disk with them:
// a stage's most (mseStageLimit); a tab's stages at once, and everyone's;
// all stages' bytes together; and, as a download does (fetchSpare), the
// disk's room left after each piece.
const (
	mseStagesPerTab = 4 // (a feed loads its next video while one plays)
	mseStagesMax    = 16
	mseStagedMax    = 2 << 30
)

const (
	mseStageLimit     = 512 << 20
	mseChunk          = 256 << 10
	mseKindInit       = 1
	mseKindPart       = 2
	mseKindProgress   = 3
	mseKindTimedPart  = 4
	mseKindWindowPart = 5
	mseKindKey        = 6 // a Clear Key stream's key: {"kid":"hex","key":"hex"}, not staged
)

// mseStageKept is how long a stage is kept with nothing spilled to it: a
// paused video, or a stream slow to fill a spill, keeps it; one left is
// forgotten. (A var for tests.)
var mseStageKept = 30 * time.Minute

// mseStage holds spilled clear-MP4 pieces on disk until Save remuxes them.
type mseStage struct {
	id, tab, folder, dir string // folder is the logical Downloads path; dir is the staging folder

	m       *fetchManager
	writing func() // its folder's write, going on while it's staged (folderWrites)

	mu          sync.Mutex
	bytes       int64
	progressive string // relative path of progressive file, or ""
	name        string // what it's saved as, said by the viewer (a page's download's, a Blob's), or ""
	tracks      map[int]*mseStageTrack
	keys        map[string]string // a Clear Key stream's keys: key ID in hex, key in hex
	done        bool              // forgotten, or taken for saving
	abort       chan struct{}     // closed as it's done
	idle        *time.Timer       // forgets it after mseStageKept with nothing spilled
}

type mseStageTrack struct {
	webm     bool // a WebM stream's (gowebm.go), not an MP4's
	header   *mp4.InitSegment
	needSync map[uint32]bool
	init     string   // relative path
	parts    []string // relative paths
	offsets  []float64
}

func (m *fetchManager) stagesLocked() map[string]*mseStage {
	if m.mseStages == nil {
		m.mseStages = map[string]*mseStage{}
	}
	return m.mseStages
}

// openMSEStage creates a staging folder for tab. It does not take a fetch
// slot, but counts against the stages a tab, and everyone, may have; and
// is a write into its folder (not deleted or moved meanwhile) till it's
// forgotten.
func (m *fetchManager) openMSEStage(tab, dir string) (*mseStage, error) {
	m.mu.Lock()
	mine, all := 0, len(m.mseStages)
	for _, s := range m.mseStages {
		if s.tab == tab {
			mine++
		}
	}
	m.mu.Unlock()
	if mine >= mseStagesPerTab || all >= mseStagesMax {
		return nil, errors.New("too many buffered streams are being kept just now: save or close one")
	}
	dir = path.Clean(strings.Trim(dir, "/"))
	if dir == "" || dir == "." {
		dir = "."
	}
	store, err := m.files.openStore()
	if err != nil {
		return nil, errors.New("the exposed folder is unavailable")
	}
	defer store.Close()
	real := m.files.resolved(dir)
	st, err := store.root.Stat(real)
	if err != nil || !st.IsDir() {
		return nil, errors.New("the download folder isn't available")
	}
	writing, err := m.files.root.writes.begin(real)
	if err != nil {
		return nil, err
	}
	b := make([]byte, 8)
	rand.Read(b)
	id := hex.EncodeToString(b)
	stageDir := path.Join(real, uploadTempPrefix+id+".mse")
	if err := store.root.Mkdir(stageDir, 0o700); err != nil {
		writing()
		return nil, err
	}
	s := &mseStage{
		id: id, tab: tab, folder: dir, dir: stageDir, m: m, writing: writing,
		tracks: map[int]*mseStageTrack{},
		abort:  make(chan struct{}),
	}
	m.mu.Lock()
	mine = 0
	for _, o := range m.stagesLocked() {
		if o.tab == tab {
			mine++
		}
	}
	if mine >= mseStagesPerTab || len(m.mseStages) >= mseStagesMax {
		// (Others opened meanwhile.)
		m.mu.Unlock()
		store.root.RemoveAll(stageDir)
		writing()
		return nil, errors.New("too many buffered streams are being kept just now: save or close one")
	}
	m.mseStages[id] = s
	s.idle = time.AfterFunc(mseStageKept, func() { m.forgetMSEStage(id) })
	m.mu.Unlock()
	return s, nil
}

func (m *fetchManager) mseStage(id string) *mseStage {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mseStages[id]
}

func (m *fetchManager) forgetMSEStage(id string) {
	m.mu.Lock()
	s := m.mseStages[id]
	if s != nil {
		delete(m.mseStages, id)
	}
	m.mu.Unlock()
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.done {
		// Taken for saving: the save gives it back (takeMSEStage).
		s.mu.Unlock()
		return
	}
	s.done = true
	close(s.abort)
	s.mu.Unlock()
	m.releaseMSEStage(s)
}

// releaseMSEStage gives back what a stage done with held: its staging
// folder, its bytes of all stages', its write into its folder.
func (m *fetchManager) releaseMSEStage(s *mseStage) {
	if s.idle != nil {
		s.idle.Stop()
	}
	s.mu.Lock()
	held := s.bytes
	s.bytes = 0
	s.mu.Unlock()
	if store, err := m.files.openStore(); err == nil {
		store.root.RemoveAll(s.dir)
		store.Close()
	}
	m.mu.Lock()
	m.mseBytes = max(0, m.mseBytes-held)
	m.mu.Unlock()
	if s.writing != nil {
		s.writing()
	}
}

// stageWrite writes data to the stage's file name (appended, or a new
// file), if the disk keeps fetchSpare free after it, as a download does.
func (s *mseStage) stageWrite(store *downloadStore, name string, flags int, data []byte) error {
	f, err := store.root.OpenFile(name, flags, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if s.m != nil {
		if free, _, ok := s.m.files.uploadRoom(f); ok && free < int64(len(data))+fetchSpare {
			return errors.New("insufficient disk space for the buffered stream")
		}
	}
	_, err = f.Write(data)
	return err
}

func (m *fetchManager) abortMSEStagesForTab(tab string) {
	m.mu.Lock()
	var ids []string
	for id, s := range m.mseStages {
		if s.tab == tab {
			ids = append(ids, id)
		}
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.forgetMSEStage(id)
	}
}

func (g *server) abortMSEStages(tab string) {
	for _, files := range g.fileServices() {
		if files.root.fetches != nil {
			files.root.fetches.abortMSEStagesForTab(tab)
		}
	}
}

func (s *mseStage) appendFrame(store *downloadStore, track int, kind byte, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return errors.New("buffered stream was cancelled")
	}
	if track < 0 || track > 7 {
		return errors.New("invalid stream track")
	}
	if kind == mseKindKey {
		// A Clear Key stream's key (mse-capture.js): kept for the save
		// (stageTrackInit), not staged; a renewal replaces its key ID's.
		var k struct{ Kid, Key string }
		if json.Unmarshal(data, &k) != nil {
			return errors.New("invalid stream key")
		}
		if kid, err := hex.DecodeString(k.Kid); err != nil || len(kid) != 16 {
			return errors.New("invalid stream key ID")
		}
		if key, err := hex.DecodeString(k.Key); err != nil || (len(key) != 16 && len(key) != 32) {
			return errors.New("invalid stream key")
		}
		if len(s.keys) >= 8 && s.keys[k.Kid] == "" {
			return errors.New("too many keys for the buffered stream")
		}
		if s.keys == nil {
			s.keys = map[string]string{}
		}
		s.keys[k.Kid] = k.Key
		if s.idle != nil {
			s.idle.Reset(mseStageKept)
		}
		return nil
	}
	var offset, windowStart float64
	windowEnd := math.Inf(1)
	if kind == mseKindWindowPart {
		if len(data) <= 24 {
			return errors.New("missing windowed fragment")
		}
		windowStart = math.Float64frombits(binary.BigEndian.Uint64(data[8:]))
		windowEnd = math.Float64frombits(binary.BigEndian.Uint64(data[16:]))
		if !(windowStart >= 0 && windowEnd > windowStart) {
			return errors.New("invalid fragment append window")
		}
	}
	if kind == mseKindTimedPart || kind == mseKindWindowPart {
		if len(data) <= 8 {
			return errors.New("missing timed fragment")
		}
		offset = math.Float64frombits(binary.BigEndian.Uint64(data))
		if math.IsNaN(offset) || math.IsInf(offset, 0) {
			return errors.New("invalid fragment offset")
		}
		if kind == mseKindWindowPart {
			data = data[24:]
		} else {
			data = data[8:]
		}
		kind = mseKindPart
	}
	if len(data) == 0 || int64(len(data)) > segmentLimit {
		return errors.New("invalid stream segment")
	}
	// A WebM stream's part at an offset or within a window: not saved
	// (gowebm.go takes its blocks' times as they are).
	if tr := s.tracks[track]; kind == mseKindPart && tr != nil && tr.webm && (offset != 0 || windowStart > 0 || !math.IsInf(windowEnd, 1)) {
		return errors.New("a WebM stream appended at an offset can't be saved")
	}
	if tr := s.tracks[track]; kind == mseKindPart && tr != nil && tr.init != "" && !tr.webm && (windowStart > 0 || !math.IsInf(windowEnd, 1) || offset < 0 || len(tr.needSync) > 0) {
		if tr.header == nil {
			init, err := store.root.ReadFile(tr.init)
			if err != nil {
				return err
			}
			tr.header, err = decodeStreamInit(init)
			if err != nil {
				if errors.Is(err, errStreamEncrypted) {
					return errors.New("an encrypted stream appended in a seek window can't be saved")
				}
				return err
			}
			tr.needSync = make(map[uint32]bool)
		}
		var err error
		data, err = clipMSEPart(data, tr.header, offset, windowStart, windowEnd, tr.needSync)
		if err != nil {
			return err
		}
		if len(data) == 0 {
			return nil
		}
	}
	if s.bytes+int64(len(data)) > mseStageLimit {
		return errors.New("buffered stream is too large")
	}
	// All stages' bytes together, held for this piece (given back if it
	// isn't kept).
	if s.m != nil {
		s.m.mu.Lock()
		if s.m.mseBytes+int64(len(data)) > mseStagedMax {
			s.m.mu.Unlock()
			return errors.New("buffered streams are holding too much just now: save or close one")
		}
		s.m.mseBytes += int64(len(data))
		s.m.mu.Unlock()
	}
	kept := false
	defer func() {
		if kept {
			s.bytes += int64(len(data))
		} else if s.m != nil {
			s.m.mu.Lock()
			s.m.mseBytes -= int64(len(data))
			s.m.mu.Unlock()
		}
	}()
	switch kind {
	case mseKindProgress:
		if len(s.tracks) > 0 {
			return errors.New("invalid buffered stream")
		}
		name := path.Join(s.dir, "progressive.mp4")
		flags := os.O_WRONLY | os.O_APPEND
		if s.progressive == "" {
			flags = os.O_WRONLY | os.O_CREATE | os.O_EXCL
		}
		if err := s.stageWrite(store, name, flags, data); err != nil {
			return err
		}
		s.progressive = name
	case mseKindInit:
		if s.progressive != "" {
			return errors.New("invalid buffered stream")
		}
		tr := s.tracks[track]
		if tr == nil {
			tr = &mseStageTrack{}
			s.tracks[track] = tr
		}
		if tr.init != "" {
			return errors.New("stream init already sent")
		}
		name := path.Join(s.dir, fmt.Sprintf("t%d-init", track))
		if err := s.stageWrite(store, name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, data); err != nil {
			return err
		}
		tr.init = name
		tr.webm = isWebM(data)
	case mseKindPart:
		if s.progressive != "" {
			return errors.New("invalid buffered stream")
		}
		tr := s.tracks[track]
		if tr == nil || tr.init == "" {
			return errors.New("stream part before init")
		}
		name := path.Join(s.dir, fmt.Sprintf("t%d-p%d", track, len(tr.parts)))
		if err := s.stageWrite(store, name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, data); err != nil {
			return err
		}
		tr.parts = append(tr.parts, name)
		tr.offsets = append(tr.offsets, offset)
	default:
		return errors.New("invalid stream frame")
	}
	kept = true
	if s.idle != nil {
		s.idle.Reset(mseStageKept) // kept while it's spilled to
	}
	return nil
}

// inputLocked lists what the stage holds, for saving: its files, in track
// order. (They're read as the save writes them, not into memory.)
func (s *mseStage) inputLocked() (mseSaveInput, error) {
	if s.progressive != "" {
		if len(s.keys) > 0 {
			return mseSaveInput{}, errors.New("an encrypted whole file can't be saved")
		}
		return mseSaveInput{progressive: s.progressive, name: s.name}, nil
	}
	if len(s.tracks) == 0 {
		return mseSaveInput{}, errors.New("buffered stream has no media tracks")
	}
	indexes := make([]int, 0, len(s.tracks))
	for i := range s.tracks {
		indexes = append(indexes, i)
	}
	sort.Ints(indexes)
	var tracks []mseTrackFiles
	for _, i := range indexes {
		tr := s.tracks[i]
		if tr.init == "" || len(tr.parts) == 0 {
			continue // (its init come, not yet a part: the others saved)
		}
		tracks = append(tracks, mseTrackFiles{init: tr.init, parts: append([]string(nil), tr.parts...), offsets: tr.offsets})
	}
	if len(tracks) == 0 {
		return mseSaveInput{}, errors.New("buffered stream has no media segments yet")
	}
	in := mseSaveInput{tracks: tracks}
	if len(s.keys) > 0 {
		in.keys = make(map[string][]byte, len(s.keys))
		for kid, key := range s.keys {
			b, err := hex.DecodeString(key)
			if err != nil {
				return mseSaveInput{}, err
			}
			in.keys[kid] = b
		}
	}
	return in, nil
}

// mseSaveInput is a stage's files, to be saved: a progressive MP4's, or
// each track's init and parts. keys is a Clear Key stream's (key ID in
// hex): its tracks are staged encrypted, decrypted as they're saved.
type mseSaveInput struct {
	progressive string
	name        string // the progressive file's name, if said
	tracks      []mseTrackFiles
	keys        map[string][]byte
}

type mseTrackFiles struct {
	offsets []float64
	init    string
	parts   []string
}

// takeMSEStage takes a stage for saving, in one step under its lock (so it
// can't be forgotten meanwhile, by its tab's end or its time up, and closed
// twice): no longer listed or spilled to, its files the save's till
// release, which gives back all it held (its folder, its bytes, its write)
// and is called once the save's done with them, whatever came of it.
func (m *fetchManager) takeMSEStage(stage *mseStage) (mseSaveInput, func(), error) {
	stage.mu.Lock()
	if stage.done {
		stage.mu.Unlock()
		return mseSaveInput{}, nil, errors.New("buffered stream was cancelled")
	}
	in, err := stage.inputLocked()
	if err != nil {
		stage.mu.Unlock()
		return mseSaveInput{}, nil, err
	}
	stage.done = true
	close(stage.abort)
	stage.mu.Unlock()
	m.mu.Lock()
	delete(m.mseStages, stage.id)
	m.mu.Unlock()
	var once sync.Once
	return in, func() { once.Do(func() { m.releaseMSEStage(stage) }) }, nil
}

// startMSE starts a fetch that remuxes staged (or in-memory) MSE tracks into Downloads.
func (m *fetchManager) startMSE(dir, by, ip, who string, from *goFrom, userAgent string) (job *fetchJob, input chan<- mseSaveInput, err error) {
	// (The input's files are its caller's to give back: takeMSEStage's
	// release, once the job's done.)
	var releaseTab func()
	if from != nil && from.holdDownload != nil {
		releaseTab, err = from.holdDownload()
		if err != nil {
			return nil, nil, err
		}
		defer func() {
			if err != nil {
				releaseTab()
			}
		}()
	}
	b := make([]byte, 8)
	rand.Read(b)
	ctx, cancel := context.WithCancel(context.Background())
	j := &fetchJob{id: hex.EncodeToString(b), host: "buffered stream", dir: dir, by: by, ip: ip, who: who, cancel: cancel, done: make(chan struct{}),
		name: "stream.mp4", total: -1, client: m.goClient, from: from, userAgent: userAgent, stream: true}
	j.real = m.files.resolved(dir)
	ready := make(chan mseSaveInput, 1)
	m.mu.Lock()
	release := func() {}
	if m.slots != nil {
		select {
		case m.slots <- struct{}{}:
			release = func() { <-m.slots }
		default:
			m.mu.Unlock()
			cancel()
			return nil, nil, errFetchBusy
		}
	} else {
		going := 0
		for _, o := range m.jobs {
			if !o.state().Done {
				going++
			}
		}
		if going >= maxFetches {
			m.mu.Unlock()
			cancel()
			return nil, nil, errFetchBusy
		}
	}
	writing, err := m.files.root.writes.begin(j.real)
	if err != nil {
		release()
		m.mu.Unlock()
		cancel()
		return nil, nil, err
	}
	if m.jobs == nil {
		m.jobs = map[string]*fetchJob{}
	}
	m.jobs[j.id] = j
	m.wg.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.wg.Done()
		defer writing()
		defer cancel()
		var err error
		select {
		case <-ctx.Done():
			err = ctx.Err()
		case in := <-ready:
			err = m.runMSE(ctx, j, in)
		}
		release()
		j.set(func(j *fetchJob) {
			switch {
			case err == nil:
			case ctx.Err() != nil:
				j.cancelled = true
				j.err = "cancelled"
			default:
				j.err = err.Error()
			}
		})
		close(j.done)
		if releaseTab != nil {
			releaseTab()
		}
		s := j.state()
		switch {
		case err == nil:
			m.activity.addFileAs(j.who, m.files.root.ID, dir, "fetch", ip, "fetched %s (%s) from %s into %s", s.Name, humanSize(s.Got), j.host, m.files.folderText(dir))
		case ctx.Err() != nil:
			m.activity.addFileAs(j.who, m.files.root.ID, dir, "fetch", ip, "fetch of %s from %s cancelled", s.Name, j.host)
		default:
			log.Printf("fetch from %s into %q failed: %v", j.host, dir, err)
			m.activity.addFileAs(j.who, m.files.root.ID, dir, "fetch", ip, "fetch from %s failed: %v", j.host, err)
		}
		time.AfterFunc(fetchKept, func() { m.forget(j) })
	}()
	return j, ready, nil
}

func (m *fetchManager) runMSE(ctx context.Context, j *fetchJob, in mseSaveInput) error {
	store, err := m.files.openStore()
	if err != nil {
		return errors.New("the exposed folder is unavailable")
	}
	defer store.Close()
	up, err := store.startUpload(j.real)
	if err != nil {
		return errors.New(strings.TrimSuffix(uploadError(err), "."))
	}
	saved := false
	defer func() {
		if !saved {
			up.abort()
		}
	}()
	var name string
	if in.progressive != "" {
		name, err = m.saveProgressiveMSE(ctx, j, store, in.progressive, in.name, up)
	} else {
		tracks := make([]streamTrack, 0, len(in.tracks))
		var webm []webmInput
		for _, tr := range in.tracks {
			init, err := store.root.ReadFile(tr.init)
			if err != nil {
				return err
			}
			parts := tr.parts
			partAt := func(i int) ([]byte, error) { return store.root.ReadFile(parts[i]) }
			if isWebM(init) {
				if len(in.keys) > 0 {
					return errors.New("an encrypted WebM stream can't be saved")
				}
				webm = append(webm, webmInput{init: init, partCount: len(parts), partAt: partAt})
				continue
			}
			// A Clear Key stream's (its keys came as it played): its init
			// and parts are staged encrypted, decrypted as they're read,
			// so what's remuxed, and saved, is clear.
			clearInit, di, err := stageTrackInit(init, in.keys)
			if err != nil {
				return err
			}
			if di != nil {
				keys, info := in.keys, *di
				partAt = func(i int) ([]byte, error) {
					data, err := store.root.ReadFile(parts[i])
					if err != nil {
						return nil, err
					}
					return decryptStageFragment(data, info, keys)
				}
			}
			tracks = append(tracks, streamTrack{initData: clearInit, partCount: len(parts), offsets: tr.offsets, partAt: partAt})
		}
		switch {
		case len(webm) > 0 && len(tracks) > 0:
			err = errors.New("the buffered stream's tracks are of different formats, and can't be saved together")
		case len(webm) > 0:
			name = "stream.webm"
			j.set(func(j *fetchJob) { j.name, j.parts = name, 1 })
			err = writeWebM(ctx, webm, up, func(n int64) error {
				j.set(func(j *fetchJob) { j.total = n })
				if free, _, ok := m.files.uploadRoom(up.f); ok && free < n+fetchSpare {
					return errors.New("insufficient disk space for stream")
				}
				return nil
			}, func(n int64) {
				j.set(func(j *fetchJob) { j.got += n })
			})
			if err == nil {
				j.set(func(j *fetchJob) { j.partsDone = 1 })
			}
		default:
			name, err = m.writeStreamTracks(ctx, j, tracks, nil, up, "stream.mp4")
		}
	}
	if err != nil {
		return err
	}
	as, err := up.finish(name, false)
	saved = true
	if err != nil {
		return errors.New(strings.TrimSuffix(uploadError(err), "."))
	}
	j.set(func(j *fetchJob) {
		j.name = as
		if up.unsynced {
			j.warning = "saved, but the disk didn't confirm it"
		}
		if j.got <= 0 {
			j.got = 1
		}
		if j.total < 0 {
			j.total = j.got
		}
	})
	log.Printf("fetched %q (%s) from %s", path.Join(j.dir, as), humanSize(j.state().Got), j.host)
	return nil
}

// stageTrackInit decodes a stage track's MP4 init for saving. With a Clear
// Key stream's keys, an encrypted one is decrypted: returned is its clear
// init (re-encoded: the parsed one was decrypted in place) and what its
// fragments' decryptStageFragment takes. Without keys, an encrypted one is
// refused (errStreamEncrypted), as any stream's is.
func stageTrackInit(init []byte, keys map[string][]byte) (clear []byte, di *mp4.DecryptInfo, err error) {
	parsed, di, err := decodeInitSegment(init, keys)
	if err != nil {
		return nil, nil, err
	}
	if di == nil {
		return init, nil, nil
	}
	var buf bytes.Buffer
	if err := parsed.Encode(&buf); err != nil {
		return nil, nil, err
	}
	return buf.Bytes(), di, nil
}

// decryptStageFragment decrypts a staged fragment (a moof and its mdat)
// with a Clear Key stream's keys: its senc and pssh go, its samples are
// clear, and it's the same length less them; what's before the moof (a
// styp, a sidx) and after the mdat (an emsg, a free) is kept as it is.
func decryptStageFragment(data []byte, di mp4.DecryptInfo, keys map[string][]byte) (clear []byte, err error) {
	defer func() {
		if recover() != nil {
			clear, err = nil, errors.New("invalid encrypted MP4 fragment")
		}
	}()
	// (One moof and its mdat a part: mse-capture.js spills them as they
	// complete. Another's boxes are kept.)
	at, moof := 0, -1
	for at+8 <= len(data) {
		n := int(binary.BigEndian.Uint32(data[at:]))
		header := 8
		if n == 1 {
			if at+16 > len(data) {
				break
			}
			n = int(binary.BigEndian.Uint64(data[at+8:]))
			header = 16
		} else if n == 0 {
			n = len(data) - at
		}
		if n < header || at+n > len(data) {
			break
		}
		if string(data[at+4:at+8]) == "moof" {
			moof = at
			break
		}
		at += n
	}
	if moof < 0 {
		return nil, errors.New("invalid encrypted MP4 fragment")
	}
	file, err := mp4.DecodeFileSR(bits.NewFixedSliceReader(data[moof:]))
	if err != nil {
		return nil, err
	}
	var frags []*mp4.Fragment
	for _, seg := range file.Segments {
		frags = append(frags, seg.Fragments...)
	}
	if len(frags) == 0 {
		return nil, errors.New("invalid encrypted MP4 fragment")
	}
	var out bytes.Buffer
	out.Write(data[:moof])
	for _, frag := range frags {
		if err := mp4.DecryptFragmentWithKeys(frag, di, nil, keys, true); err != nil {
			return nil, err
		}
		if err := frag.Encode(&out); err != nil {
			return nil, err
		}
	}
	return out.Bytes(), nil
}

func (m *fetchManager) saveProgressiveMSE(ctx context.Context, j *fetchJob, store *downloadStore, file, name string, up *upload) (string, error) {
	f, err := store.root.Open(file)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if name == "" {
		head := make([]byte, 16)
		n, _ := io.ReadFull(f, head)
		name = goMediaFileName(head[:n])
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return "", err
		}
	}
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	if st.Size() == 0 {
		return "", errors.New("buffered stream has no media tracks")
	}
	j.set(func(j *fetchJob) {
		j.name = name
		j.total = st.Size()
		j.parts = 1
	})
	if free, _, ok := m.files.uploadRoom(up.f); ok && free < st.Size()+fetchSpare {
		return "", errors.New("insufficient disk space for stream")
	}
	// Copied a piece at a time, so a cancel's taken between pieces.
	buf := make([]byte, 1<<20)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, err := f.Read(buf)
		if n > 0 {
			if _, werr := up.Write(buf[:n]); werr != nil {
				return "", werr
			}
			j.set(func(j *fetchJob) { j.got += int64(n) })
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", err
		}
	}
	j.set(func(j *fetchJob) { j.partsDone = 1 })
	return name, nil
}

var errMSEText = errors.New("mse text")

// goMediaFileName is a whole media file's name, by what its first bytes
// say it is (a Blob's played, saved: its name unsaid).
func goMediaFileName(head []byte) string {
	switch {
	case len(head) >= 12 && string(head[4:8]) == "ftyp" && (string(head[8:12]) == "M4A " || string(head[8:12]) == "M4B "):
		return "audio.m4a"
	case len(head) >= 8 && string(head[4:8]) == "ftyp":
		return "stream.mp4"
	case isWebM(head):
		return "stream.webm"
	case bytes.HasPrefix(head, []byte("OggS")):
		return "audio.ogg"
	case bytes.HasPrefix(head, []byte("fLaC")):
		return "audio.flac"
	case len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WAVE":
		return "audio.wav"
	case bytes.HasPrefix(head, []byte("ID3")), len(head) >= 2 && head[0] == 0xFF && head[1]&0xE0 == 0xE0:
		return "audio.mp3"
	}
	return "media.bin"
}

// serveMSEStage accepts spilled frames until finalize or cancel. It waits
// for the next frame as long as the stage is kept (mseStageKept since the
// last: a paused video sends none), not a transfer's stall.
func (m *fetchManager) serveMSEStage(t *tunnel, stage *mseStage, r *tunnelResponder, by, ip, who string, from *goFrom, userAgent string) {
	store, err := m.files.openStore()
	if err != nil {
		r.fail("the exposed folder is unavailable")
		m.forgetMSEStage(stage.id)
		return
	}
	defer store.Close()

	// Its life: over as it's forgotten (its tab's end, its time up) or taken.
	life, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		select {
		case <-stage.abort:
			stop()
		case <-life.Done():
		}
	}()
	if from != nil && from.ended != nil {
		go func() {
			select {
			case <-from.ended:
				m.forgetMSEStage(stage.id)
			case <-life.Done():
			}
		}()
	}

	for {
		typ, p, err := t.Read(life)
		if err != nil {
			if life.Err() != nil {
				r.fail("buffered stream was cancelled")
			}
			m.forgetMSEStage(stage.id)
			return
		}
		if typ == websocket.MessageText {
			var msg struct {
				Cancel   bool `json:"cancel"`
				Finalize bool `json:"finalize"`
				// Its name (a whole file's: a page's download, a Blob's).
				Name string `json:"name"`
			}
			if json.Unmarshal(p, &msg) != nil || !msg.Cancel && !msg.Finalize {
				r.fail("invalid stream message")
				m.forgetMSEStage(stage.id)
				return
			}
			if msg.Cancel {
				m.forgetMSEStage(stage.id)
				r.fail("cancelled")
				return
			}
			if n := cleanFetchName(msg.Name); n != "" {
				stage.mu.Lock()
				stage.name = n
				stage.mu.Unlock()
			}
			if m.finishMSEStage(t, stage, r, by, ip, who, from, userAgent) {
				return
			}
			// Refused (every fetch going): the stage goes on, to be saved again.
			continue
		}
		track, kind, data, err := readMSEFrameFrom(t, p)
		if err != nil {
			m.forgetMSEStage(stage.id)
			if errors.Is(err, errMSEText) {
				r.fail("cancelled") // (a text message within a frame)
			} else {
				r.fail(err.Error())
			}
			return
		}
		if err := stage.appendFrame(store, track, kind, data); err != nil {
			m.forgetMSEStage(stage.id)
			r.fail(err.Error())
			return
		}
	}
}

// finishMSEStage saves a stage (Save): takes it, starts the save with its
// files, which the save gives back once it's done with them, and reports
// the save till it ends. False if the save couldn't start (every fetch
// going, say): the page's told ({"refused"}), and the stage, with all it
// holds, goes on being spilled to, to be saved again.
func (m *fetchManager) finishMSEStage(t *tunnel, stage *mseStage, r *tunnelResponder, by, ip, who string, from *goFrom, userAgent string) bool {
	// Nothing to save yet (no track with a part): refused too, the stage
	// kept (a Save pressed as a track's init's come but not its first part).
	stage.mu.Lock()
	_, err := stage.inputLocked()
	stage.mu.Unlock()
	var j *fetchJob
	var input chan<- mseSaveInput
	if err == nil {
		j, input, err = m.startMSE(stage.folder, by, ip, who, from, userAgent)
	}
	if err != nil {
		if writeJSON(t, map[string]any{"refused": err.Error()}) != nil {
			m.forgetMSEStage(stage.id)
			return true
		}
		return false
	}
	in, release, err := m.takeMSEStage(stage)
	if err != nil {
		j.cancel()
		r.fail(err.Error())
		m.forgetMSEStage(stage.id)
		return true
	}
	go func() {
		<-j.done
		release()
	}()
	select {
	case input <- in:
	case <-j.done:
	}
	if err := writeJSON(t, map[string]any{"fetch": j.state()}); err != nil {
		j.cancel()
		return true
	}
	gone := cancelOnText(t, j.cancel)
	tick := time.NewTicker(fetchTick)
	defer tick.Stop()
	for {
		select {
		case <-j.done:
			s := j.state()
			if s.Error != "" {
				r.fail(s.Error)
				return true
			}
			res := map[string]any{"fetch": s}
			j.mu.Lock()
			if j.warning != "" {
				res["warning"] = j.warning
			}
			j.mu.Unlock()
			r.finish(res)
			return true
		case <-gone:
			return true
		case <-tick.C:
			if err := writeJSON(t, map[string]any{"fetch": j.state()}); err != nil {
				return true
			}
		}
	}
}

// readMSEFrameFrom is readMSEFrame with an initial binary payload already read.
func readMSEFrameFrom(t *tunnel, first []byte) (track int, kind byte, data []byte, err error) {
	t.c.SetReadLimit(mseChunk + tunnelOverhead)
	buf := append([]byte(nil), first...)
	// Ack the first message.
	ctx, cancel := context.WithTimeout(context.Background(), tunnelTimeout)
	err = t.Write(ctx, websocket.MessageBinary, nil)
	cancel()
	if err != nil {
		return 0, 0, nil, err
	}
	need := -1
	for {
		if need < 0 {
			if len(buf) >= 6 {
				track = int(buf[0])
				kind = buf[1]
				need = int(binary.BigEndian.Uint32(buf[2:6]))
				limit := segmentLimit
				if kind == mseKindTimedPart {
					limit += 8
				} else if kind == mseKindWindowPart {
					limit += 24
				}
				if need <= 0 || need > limit {
					return 0, 0, nil, errors.New("invalid stream segment")
				}
				buf = buf[6:]
			}
		}
		if need >= 0 && len(buf) >= need {
			if len(buf) > need {
				return 0, 0, nil, errors.New("bad stream upload")
			}
			return track, kind, buf, nil
		}
		ctx, cancel = context.WithTimeout(context.Background(), fileStall)
		typ, p, readErr := t.Read(ctx)
		cancel()
		if readErr != nil {
			return 0, 0, nil, readErr
		}
		if typ == websocket.MessageText {
			return 0, 0, nil, errMSEText
		}
		if len(p) == 0 {
			return 0, 0, nil, errors.New("bad stream upload")
		}
		buf = append(buf, p...)
		ctx, cancel = context.WithTimeout(context.Background(), tunnelTimeout)
		err = t.Write(ctx, websocket.MessageBinary, nil)
		cancel()
		if err != nil {
			return 0, 0, nil, err
		}
	}
}
