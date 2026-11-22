package main

import (
	"bytes"
	"errors"
	"math"

	"github.com/Eyevinn/mp4ff/bits"
	"github.com/Eyevinn/mp4ff/mp4"
)

// clipMSEPart applies the SourceBuffer append window in presentation time.
// A discarded picture breaks video dependencies until the next sync sample.
// Keep that state across appends, including a return to the default window.
func clipMSEPart(data []byte, init *mp4.InitSegment, offset, start, end float64, needSync map[uint32]bool) (result []byte, err error) {
	defer func() {
		if recover() != nil {
			result = nil
			err = errors.New("invalid windowed MP4 fragment")
		}
	}()
	file, err := mp4.DecodeFileSR(bits.NewFixedSliceReader(data))
	if err != nil {
		return nil, err
	}
	if len(file.Segments) == 0 {
		return nil, errors.New("missing windowed media segment")
	}
	type sampleRun struct {
		id      uint32
		samples []mp4.FullSample
	}
	var runs []sampleRun
	trimmed := false
	for _, segment := range file.Segments {
		for _, frag := range segment.Fragments {
			if frag.Moof == nil || frag.Mdat == nil {
				return nil, errors.New("incomplete windowed fragment")
			}
			for _, traf := range frag.Moof.Trafs {
				if enc, _ := traf.ContainsSencBox(); enc {
					return nil, errors.New("encrypted fragments are unsupported")
				}
				if traf.Tfhd == nil || traf.Tfdt == nil || traf.Tfhd.HasBaseDataOffset() {
					return nil, errors.New("windowed fragment needs explicit track timing and relative addressing")
				}
				id := traf.Tfhd.TrackID
				var trak *mp4.TrakBox
				for _, t := range init.Moov.Traks {
					if t.Tkhd.TrackID == id {
						trak = t
						break
					}
				}
				var defaults *mp4.TrexBox
				for _, t := range init.Moov.Mvex.Trexs {
					if t.TrackID == id {
						defaults = t
						break
					}
				}
				if trak == nil || defaults == nil || trak.Mdia.Hdlr == nil {
					return nil, errors.New("missing windowed track header")
				}
				video := trak.Mdia.Hdlr.HandlerType == "vide"
				scale := float64(trak.Mdia.Mdhd.Timescale)
				from := math.Nextafter((start-offset)*scale, math.Inf(-1))
				to := math.Nextafter((end-offset)*scale, math.Inf(1))
				samples, err := frag.GetFullSamples(defaults)
				if err != nil {
					return nil, err
				}
				first := 0
				for i, sample := range samples {
					pts := float64(sample.PresentationTime())
					inside := pts >= from && pts+float64(sample.Dur) <= to
					if video && !inside {
						needSync[id] = true
					}
					flags := mp4.DecodeSampleFlags(sample.Flags)
					if inside && (!needSync[id] || (!flags.SampleIsNonSync && flags.SampleDependsOn != 1)) {
						delete(needSync, id)
						continue
					}
					trimmed = true
					if first < i {
						runs = append(runs, sampleRun{id, samples[first:i]})
					}
					first = i + 1
				}
				if first < len(samples) {
					runs = append(runs, sampleRun{id, samples[first:]})
				}
			}
		}
	}
	if !trimmed {
		return data, nil
	}
	var out bytes.Buffer
	for _, run := range runs {
		f, err := mp4.CreateFragment(1, run.id)
		if err != nil {
			return nil, err
		}
		for _, sample := range run.samples {
			f.AddFullSample(sample)
		}
		if err := f.Encode(&out); err != nil {
			return nil, err
		}
	}
	return out.Bytes(), nil
}
