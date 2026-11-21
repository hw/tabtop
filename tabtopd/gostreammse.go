package main

// Save of a clear Media Source stream: the viewer spills completed MP4
// pieces to a staging folder during playback (mse-capture.js), then
// finalizes into Downloads as Save stream remuxes HLS/DASH (gosavestream.go).

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"strings"
	"sync"
	"time"

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
	mseStageLimit   = 512 << 20
	mseChunk        = 256 << 10
	mseKindInit     = 1
	mseKindPart     = 2
	mseKindProgress = 3
	mseStageKept    = 30 * time.Minute
)

// mseStage holds spilled clear-MP4 pieces on disk until Save remuxes them.
type mseStage struct {
	id, tab, folder, dir string // folder is the logical Downloads path; dir is the staging folder

	m       *fetchManager
	writing func() // its folder's write, going on while it's staged (folderWrites)

	mu          sync.Mutex
	bytes       int64
	progressive string // relative path of progressive file, or ""
	tracks      map[int]*mseStageTrack
	done        bool
	abort       chan struct{}
}

type mseStageTrack struct {
	init  string   // relative path
	parts []string // relative paths
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
	if n := len(m.stagesLocked()); n >= mseStagesMax {
		// (Others opened meanwhile.)
		m.mu.Unlock()
		store.root.RemoveAll(stageDir)
		writing()
		return nil, errors.New("too many buffered streams are being kept just now: save or close one")
	}
	m.mseStages[id] = s
	m.mu.Unlock()
	time.AfterFunc(mseStageKept, func() { m.forgetMSEStage(id) })
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
	if !s.done {
		s.done = true
		close(s.abort)
	}
	dir, held := s.dir, s.bytes
	s.bytes = 0
	s.mu.Unlock()
	if store, err := m.files.openStore(); err == nil {
		store.root.RemoveAll(dir)
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
	if len(data) == 0 || int64(len(data)) > segmentLimit {
		return errors.New("invalid stream segment")
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
	default:
		return errors.New("invalid stream frame")
	}
	kept = true
	return nil
}

func (s *mseStage) input(store *downloadStore) (mseSaveInput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return mseSaveInput{}, errors.New("buffered stream was cancelled")
	}
	if s.progressive != "" {
		data, err := store.root.ReadFile(s.progressive)
		if err != nil {
			return mseSaveInput{}, err
		}
		if len(data) == 0 {
			return mseSaveInput{}, errors.New("buffered stream has no media tracks")
		}
		return mseSaveInput{progressive: data}, nil
	}
	if len(s.tracks) == 0 {
		return mseSaveInput{}, errors.New("buffered stream has no media tracks")
	}
	indexes := make([]int, 0, len(s.tracks))
	for i := range s.tracks {
		indexes = append(indexes, i)
	}
	for i := 0; i < len(indexes); i++ {
		for j := i + 1; j < len(indexes); j++ {
			if indexes[j] < indexes[i] {
				indexes[i], indexes[j] = indexes[j], indexes[i]
			}
		}
	}
	var tracks []streamTrack
	for _, i := range indexes {
		tr := s.tracks[i]
		if tr.init == "" || len(tr.parts) == 0 {
			return mseSaveInput{}, errors.New("buffered stream has no media segments yet")
		}
		init, err := store.root.ReadFile(tr.init)
		if err != nil {
			return mseSaveInput{}, err
		}
		parts := make([][]byte, 0, len(tr.parts))
		for _, p := range tr.parts {
			data, err := store.root.ReadFile(p)
			if err != nil {
				return mseSaveInput{}, err
			}
			parts = append(parts, data)
		}
		tracks = append(tracks, streamTrack{initData: init, partData: parts})
	}
	return mseSaveInput{tracks: tracks}, nil
}

type mseSaveInput struct {
	progressive []byte
	tracks      []streamTrack
}

// startMSE starts a fetch that remuxes staged (or in-memory) MSE tracks into Downloads.
func (m *fetchManager) startMSE(dir, by, ip, who string, from *goFrom, userAgent string) (job *fetchJob, input chan<- mseSaveInput, err error) {
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
	if len(in.progressive) > 0 {
		name, err = m.saveProgressiveMSE(ctx, j, in.progressive, up)
	} else {
		name, err = m.writeStreamTracks(ctx, j, in.tracks, nil, up, "stream.mp4")
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

func (m *fetchManager) saveProgressiveMSE(ctx context.Context, j *fetchJob, data []byte, up *upload) (string, error) {
	name := "stream.mp4"
	j.set(func(j *fetchJob) {
		j.name = name
		j.total = int64(len(data))
		j.parts = 1
	})
	if free, _, ok := m.files.uploadRoom(up.f); ok && free < int64(len(data))+fetchSpare {
		return "", errors.New("insufficient disk space for stream")
	}
	if _, err := up.Write(data); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	j.set(func(j *fetchJob) { j.got = int64(len(data)); j.partsDone = 1 })
	return name, nil
}

var errMSEText = errors.New("mse text")

// serveMSEStage accepts spilled frames until finalize or cancel.
func (m *fetchManager) serveMSEStage(t *tunnel, stage *mseStage, r *tunnelResponder, by, ip, who string, from *goFrom, userAgent string) {
	store, err := m.files.openStore()
	if err != nil {
		r.fail("the exposed folder is unavailable")
		m.forgetMSEStage(stage.id)
		return
	}
	defer store.Close()

	ended := make(chan struct{})
	if from != nil && from.ended != nil {
		go func() {
			select {
			case <-from.ended:
				m.forgetMSEStage(stage.id)
			case <-ended:
			}
		}()
	}
	defer close(ended)

	for {
		ctx, cancel := context.WithTimeout(context.Background(), fileStall)
		typ, p, err := t.Read(ctx)
		cancel()
		if err != nil {
			m.forgetMSEStage(stage.id)
			return
		}
		if typ == websocket.MessageText {
			var msg struct {
				Cancel   bool `json:"cancel"`
				Finalize bool `json:"finalize"`
			}
			if json.Unmarshal(p, &msg) != nil {
				r.fail("invalid stream message")
				m.forgetMSEStage(stage.id)
				return
			}
			if msg.Cancel {
				m.forgetMSEStage(stage.id)
				r.fail("cancelled")
				return
			}
			if !msg.Finalize {
				r.fail("invalid stream message")
				m.forgetMSEStage(stage.id)
				return
			}
			in, err := stage.input(store)
			if err != nil {
				r.fail(err.Error())
				m.forgetMSEStage(stage.id)
				return
			}
			// Mark done so forget won't race; remux owns the files until copied.
			stage.mu.Lock()
			stage.done = true
			close(stage.abort)
			stage.mu.Unlock()
			m.mu.Lock()
			delete(m.mseStages, stage.id)
			m.mu.Unlock()
			defer func() {
				if store2, err := m.files.openStore(); err == nil {
					store2.root.RemoveAll(stage.dir)
					store2.Close()
				}
			}()

			j, input, err := m.startMSE(stage.folder, by, ip, who, from, userAgent)
			if err != nil {
				r.fail(err.Error())
				return
			}
			if err := writeJSON(t, map[string]any{"fetch": j.state()}); err != nil {
				j.cancel()
				return
			}
			select {
			case input <- in:
			case <-j.done:
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
						return
					}
					res := map[string]any{"fetch": s}
					j.mu.Lock()
					if j.warning != "" {
						res["warning"] = j.warning
					}
					j.mu.Unlock()
					r.finish(res)
					return
				case <-gone:
					return
				case <-tick.C:
					if err := writeJSON(t, map[string]any{"fetch": j.state()}); err != nil {
						return
					}
				}
			}
		}
		// Binary: push this message back by handling as start of a frame.
		// Re-read using a buffer that already has p.
		track, kind, data, err := readMSEFrameFrom(t, p)
		if err != nil {
			if errors.Is(err, errMSEText) {
				// Shouldn't happen; treat as cancel.
				m.forgetMSEStage(stage.id)
				r.fail("cancelled")
				return
			}
			m.forgetMSEStage(stage.id)
			r.fail(err.Error())
			return
		}
		if err := stage.appendFrame(store, track, kind, data); err != nil {
			m.forgetMSEStage(stage.id)
			r.fail(err.Error())
			return
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
				if need <= 0 || need > segmentLimit {
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

// parseMSEPayload kept for tests of the legacy length-prefixed blob format.
func parseMSEPayload(buf []byte) (mseSaveInput, error) {
	if len(buf) < 4 {
		return mseSaveInput{}, errors.New("invalid buffered stream")
	}
	n := binary.BigEndian.Uint32(buf)
	buf = buf[4:]
	if n == 0 || n > 8 {
		return mseSaveInput{}, errors.New("invalid buffered stream")
	}
	var progressive []byte
	var tracks []streamTrack
	for i := uint32(0); i < n; i++ {
		if len(buf) < 5 {
			return mseSaveInput{}, io.ErrUnexpectedEOF
		}
		kind := buf[0]
		buf = buf[1:]
		initLen := binary.BigEndian.Uint32(buf)
		buf = buf[4:]
		if int(initLen) > len(buf) || initLen > mseStageLimit {
			return mseSaveInput{}, io.ErrUnexpectedEOF
		}
		init := append([]byte(nil), buf[:initLen]...)
		buf = buf[initLen:]
		if kind == 1 {
			if progressive != nil || len(tracks) > 0 || n != 1 {
				return mseSaveInput{}, errors.New("invalid buffered stream")
			}
			progressive = init
			continue
		}
		if kind != 0 || len(buf) < 4 {
			return mseSaveInput{}, errors.New("invalid buffered stream")
		}
		partsN := binary.BigEndian.Uint32(buf)
		buf = buf[4:]
		if partsN == 0 || partsN > 100000 {
			return mseSaveInput{}, errors.New("invalid buffered stream")
		}
		parts := make([][]byte, 0, partsN)
		for k := uint32(0); k < partsN; k++ {
			if len(buf) < 4 {
				return mseSaveInput{}, io.ErrUnexpectedEOF
			}
			plen := binary.BigEndian.Uint32(buf)
			buf = buf[4:]
			if int(plen) > len(buf) || plen > segmentLimit {
				return mseSaveInput{}, io.ErrUnexpectedEOF
			}
			parts = append(parts, append([]byte(nil), buf[:plen]...))
			buf = buf[plen:]
		}
		tracks = append(tracks, streamTrack{initData: init, partData: parts})
	}
	if len(buf) != 0 {
		return mseSaveInput{}, errors.New("invalid buffered stream")
	}
	if progressive != nil {
		return mseSaveInput{progressive: progressive}, nil
	}
	if len(tracks) == 0 {
		return mseSaveInput{}, errors.New("buffered stream has no media tracks")
	}
	return mseSaveInput{tracks: tracks}, nil
}
