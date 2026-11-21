package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type dashTemplate struct {
	Init     string `xml:"initialization,attr"`
	Media    string `xml:"media,attr"`
	Start    *int64 `xml:"startNumber,attr"`
	Scale    int64  `xml:"timescale,attr"`
	Duration int64  `xml:"duration,attr"`
	Timeline []struct {
		T *int64 `xml:"t,attr"`
		D int64  `xml:"d,attr"`
		R int64  `xml:"r,attr"`
	} `xml:"SegmentTimeline>S"`
}
type dashRendition struct {
	ID        string       `xml:"id,attr"`
	Rate      int64        `xml:"bandwidth,attr"`
	Kind      string       `xml:"contentType,attr"`
	Mime      string       `xml:"mimeType,attr"`
	Base      string       `xml:"BaseURL"`
	Protected *struct{}    `xml:"ContentProtection"`
	Template  dashTemplate `xml:"SegmentTemplate"`
	List      *struct {
		Init struct {
			Source string `xml:"sourceURL,attr"`
			Range  string `xml:"range,attr"`
		} `xml:"Initialization"`
		Segments []struct {
			Media string `xml:"media,attr"`
			Range string `xml:"mediaRange,attr"`
		} `xml:"SegmentURL"`
	} `xml:"SegmentList"`
}

var dashToken = regexp.MustCompile(`\$\$|\$(RepresentationID|Time|Number|Bandwidth)(%0([1-9]|1[0-9])d)?\$`)

func dashURL(pattern string, r dashRendition, n, t int64) string {
	return dashToken.ReplaceAllStringFunc(pattern, func(tok string) string {
		if tok == "$$" {
			return "$"
		}
		m := dashToken.FindStringSubmatch(tok)
		var value int64
		switch m[1] {
		case "RepresentationID":
			return r.ID
		case "Time":
			value = t
		case "Number":
			value = n
		case "Bandwidth":
			value = r.Rate
		}
		width, _ := strconv.Atoi(m[3])
		return fmt.Sprintf("%0*d", width, value)
	})
}
func dashTracks(data []byte, u *url.URL) ([]streamTrack, error) {
	var manifest struct {
		XMLName  xml.Name `xml:"MPD"`
		Type     string   `xml:"type,attr"`
		Duration string   `xml:"mediaPresentationDuration,attr"`
		Base     string   `xml:"BaseURL"`
		Periods  []struct {
			Base     string `xml:"BaseURL"`
			Duration string `xml:"duration,attr"`
			Sets     []struct {
				dashRendition
				Reps []dashRendition `xml:"Representation"`
			} `xml:"AdaptationSet"`
		} `xml:"Period"`
	}
	if err := xml.Unmarshal(bytes.TrimSpace(data), &manifest); err != nil {
		return nil, errors.New("invalid HLS or DASH manifest")
	}
	if manifest.Type == "dynamic" || len(manifest.Periods) != 1 {
		return nil, errors.New("Save stream requires a single on-demand DASH period")
	}
	p := manifest.Periods[0]
	duration := p.Duration
	if duration == "" {
		duration = manifest.Duration
	}
	// (Needed only where segments repeat to the period's end: a template
	// by duration, or a timeline's r="-1"; an error there, if it's absent
	// or can't be read.)
	seconds, durationErr := dashDuration(duration)
	var tracks []streamTrack
	for _, kind := range []string{"video", "audio"} {
		found := false
		declared := false
		for _, set := range p.Sets {
			var best *dashRendition
			for i := range set.Reps {
				r := &set.Reps[i]
				mime := r.Mime
				if mime == "" {
					mime = set.Mime
				}
				if strings.HasPrefix(mime, kind+"/") || set.Kind == kind {
					declared = true
				}
				if set.Protected != nil || r.Protected != nil || (mime != kind+"/mp4" && !(mime == "" && set.Kind == kind)) {
					continue
				}
				if best == nil || r.Rate > best.Rate {
					best = r
				}
			}
			if best == nil {
				continue
			}
			base := u
			for _, part := range []string{manifest.Base, p.Base, set.Base, best.Base} {
				if part != "" {
					var err error
					base, err = base.Parse(strings.TrimSpace(part))
					if err != nil {
						return nil, err
					}
				}
			}
			t := streamTrack{base: base}
			list := best.List
			if list == nil {
				list = set.List
			}
			if list != nil {
				if list.Init.Range != "" {
					return nil, errors.New("DASH byte ranges are unsupported")
				}
				t.init = list.Init.Source
				for _, s := range list.Segments {
					if s.Range != "" || s.Media == "" {
						return nil, errors.New("unsupported DASH media range")
					}
					t.parts = append(t.parts, s.Media)
				}
			} else if err := t.expandTemplate(*best, set.Template, seconds, durationErr); err != nil {
				return nil, err
			}
			if t.init == "" || len(t.parts) == 0 {
				return nil, errors.New("DASH requires an MP4 initialization segment and media segments")
			}
			if durationErr == nil {
				t.length = seconds
			}
			tracks = append(tracks, t)
			found = true
			break
		}
		if !found && (declared || kind == "video") {
			return nil, fmt.Errorf("no unencrypted MP4 %s rendition", kind)
		}
	}
	return tracks, nil
}

// dashDuration reads an ISO 8601 duration, as MPDs write them
// (P[nY][nM][nW][nD][T[nH][nM][nS]], seconds with a fraction): in seconds.
// Years and months, whose length depends on the calendar, only as zero
// (as packagers write them: P0Y0M0DT0H3M30.000S).
func dashDuration(v string) (float64, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, errors.New("the DASH manifest gives no duration")
	}
	bad := fmt.Errorf("unreadable DASH duration %q", v)
	rest, ok := strings.CutPrefix(v, "P")
	if !ok || rest == "" {
		return 0, bad
	}
	date, clock, timed := strings.Cut(rest, "T")
	if timed && clock == "" {
		return 0, bad
	}
	total := 0.0
	read := func(part string, units map[byte]float64, order string) error {
		for part != "" {
			i := strings.IndexAny(part, order)
			if i <= 0 {
				return bad
			}
			n, err := strconv.ParseFloat(part[:i], 64)
			if err != nil || n < 0 || math.IsInf(n, 0) {
				return bad
			}
			unit := part[i]
			if units[unit] < 0 {
				if n != 0 {
					return fmt.Errorf("DASH duration %q counts in years or months", v)
				}
			} else {
				total += n * units[unit]
			}
			// Each unit once, in order.
			order = order[strings.IndexByte(order, unit)+1:]
			part = part[i+1:]
		}
		return nil
	}
	if err := read(date, map[byte]float64{'Y': -1, 'M': -1, 'W': 7 * 86400, 'D': 86400}, "YMWD"); err != nil {
		return 0, err
	}
	if err := read(clock, map[byte]float64{'H': 3600, 'M': 60, 'S': 1}, "HMS"); err != nil {
		return 0, err
	}
	if total <= 0 {
		return 0, bad
	}
	return total, nil
}

func (t *streamTrack) expandTemplate(r dashRendition, parent dashTemplate, seconds float64, durationErr error) error {
	tpl := r.Template

	if tpl.Init == "" {
		tpl.Init = parent.Init
	}
	if tpl.Media == "" {
		tpl.Media = parent.Media
	}
	if tpl.Start == nil {
		tpl.Start = parent.Start
	}
	if tpl.Scale == 0 {
		tpl.Scale = parent.Scale
	}
	if tpl.Scale == 0 {
		tpl.Scale = 1
	}
	if tpl.Duration == 0 {
		tpl.Duration = parent.Duration
	}
	if len(tpl.Timeline) == 0 {
		tpl.Timeline = parent.Timeline
	}

	n := int64(1)
	if tpl.Start != nil {
		n = *tpl.Start
	}
	if len(tpl.Media) > 8192 || len(tpl.Init) > 8192 || len(r.ID) > 256 {
		return errors.New("DASH URL template is too long")
	}
	var planBytes int
	t.init = dashURL(tpl.Init, r, n, 0)
	at := int64(0)
	add := func(count, d int64) error {
		if d <= 0 || count <= 0 || count > 100000-int64(len(t.parts)) || tpl.Media == "" {
			return errors.New("unsupported DASH segment timeline")
		}
		for range count {
			part := dashURL(tpl.Media, r, n, at)
			planBytes += len(part)
			if len(part) > 8192 || planBytes > 16<<20 {
				return errors.New("DASH segment list is too large")
			}
			t.parts = append(t.parts, part)
			t.starts = append(t.starts, float64(at)/float64(tpl.Scale))
			n++
			at += d
		}
		return nil
	}
	// The period's length, in the template's units; its end, in its
	// segments' own times: from where the timeline starts (its first t,
	// which counts from presentationTimeOffset where there's one), not 0.
	length := int64(math.Ceil(seconds * float64(tpl.Scale)))
	end := length
	if len(tpl.Timeline) > 0 && tpl.Timeline[0].T != nil {
		end += *tpl.Timeline[0].T
	}
	if len(tpl.Timeline) > 0 {
		for i, s := range tpl.Timeline {
			if s.T != nil {
				at = *s.T
			}
			count := s.R + 1
			if s.R == -1 && s.D > 0 {
				if durationErr != nil && !(i+1 < len(tpl.Timeline) && tpl.Timeline[i+1].T != nil) {
					return durationErr
				}
				until := end
				if i+1 < len(tpl.Timeline) && tpl.Timeline[i+1].T != nil {
					until = *tpl.Timeline[i+1].T
				}
				count = (until - at + s.D - 1) / s.D
			}
			if err := add(count, s.D); err != nil {
				return err
			}
		}
	} else if tpl.Duration > 0 {
		if durationErr != nil {
			return durationErr
		}
		if err := add((length+tpl.Duration-1)/tpl.Duration, tpl.Duration); err != nil {
			return err
		}
	}
	return nil
}
