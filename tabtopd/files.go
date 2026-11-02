package main

import (
	"fmt"
	"io"
	"os"
	"path"
	"slices"
	"strings"
	"time"
)

type entry struct {
	Name, Size, Modified string
	dir                  bool
	key                  string // Name in lower case, to sort by
	bytes, time          int64  // the size, and when it was modified in Unix seconds, for the page to sort by
}

// listDir lists the directory f, which is dir in root: directories first,
// then by name. It lists at most maxListing entries, as the directory
// happens to order them, and reports whether there were more. Entries left
// out (temporary uploads, broken symlinks) don't count, but at most
// maxListingScan are looked at, so a huge directory can't take forever.
func (s *downloadStore) listDir(dir string, f *os.File) (entries []entry, truncated bool, err error) {
	root := s.root
	for scanned := 0; ; {
		if scanned >= maxListingScan {
			// Stopped looking: say so if there's anything more.
			more, _ := f.ReadDir(1)
			truncated = len(more) > 0
			break
		}
		des, err := f.ReadDir(min(1000, maxListingScan-scanned))
		if err != nil && err != io.EOF {
			return nil, false, err
		}
		if len(des) == 0 {
			break
		}
		scanned += len(des)
		for _, de := range des {
			if strings.HasPrefix(de.Name(), uploadTempPrefix) {
				continue // an upload in progress
			}
			// Stat through the root: this follows symlinks that stay inside
			// and fails for ones leading outside, which are left out.
			st, err := root.Stat(path.Join(dir, de.Name()))
			if err != nil {
				continue
			}
			if len(entries) == maxListing {
				truncated = true
				break
			}
			e := entry{
				Name:     de.Name(),
				key:      strings.ToLower(de.Name()),
				Modified: st.ModTime().Format("2006-01-02 15:04"),
				dir:      st.IsDir(),
				time:     st.ModTime().Unix(),
			}
			if !e.dir {
				e.Size, e.bytes = humanSize(st.Size()), st.Size()
			}
			entries = append(entries, e)
		}
		if truncated {
			break
		}
	}
	slices.SortFunc(entries, func(a, b entry) int {
		if a.dir != b.dir {
			if a.dir {
				return -1
			}
			return 1
		}
		return strings.Compare(a.key, b.key)
	})
	return entries, truncated, nil
}

// pageTimeZone is the zone named by tz, a TZ value, for the files page to
// show times in: UTC if it's unset, or isn't a name Go knows, as a POSIX
// rule such as "CET-1CEST" isn't.
func pageTimeZone(tz string) string {
	name := strings.TrimPrefix(tz, ":")
	if name == "" || name == "Local" {
		return "UTC"
	}
	if _, err := time.LoadLocation(name); err != nil {
		return "UTC"
	}
	return name
}

func humanSize(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	size := float64(n)
	for _, unit := range []string{"KB", "MB", "GB", "TB"} {
		size /= 1024
		if size < 1024 || unit == "TB" {
			return fmt.Sprintf("%.1f %s", size, unit)
		}
	}
	return ""
}
