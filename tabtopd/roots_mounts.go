package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Canonical paths alone don't identify bind-mount aliases. A mount view maps
// an exposed subtree to its device and path inside that device's filesystem.
// Include nested mounts so an alias cannot bypass a read-only root through
// another exposed parent's mounted child.
type rootMount struct{ device, source, target string }
type rootMountView struct{ device, source string }

func pathWithin(child, parent string) bool {
	return child == parent || parent == string(os.PathSeparator) || strings.HasPrefix(child, parent+string(os.PathSeparator))
}
func rootMounts() ([]rootMount, error) {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil, fmt.Errorf("can't validate filesystem root mount aliases: %w", err)
	}
	decode := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	mounts := []rootMount{}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}
		mounts = append(mounts, rootMount{device: fields[2], source: filepath.Clean(decode.Replace(fields[3])), target: filepath.Clean(decode.Replace(fields[4]))})
	}
	return mounts, nil
}

// mountViews is what dir shows: the mount it's in, and those inside it.
// Where several are mounted at one place, the last, on top, is what's
// seen there (mountinfo lists them in the order they were mounted).
func mountViews(dir string, mounts []rootMount) []rootMountView {
	top := map[string]rootMount{}
	var order []string
	for _, m := range mounts {
		if _, ok := top[m.target]; !ok {
			order = append(order, m.target)
		}
		top[m.target] = m
	}
	var nearest *rootMount
	for _, target := range order {
		m := top[target]
		if pathWithin(dir, m.target) && (nearest == nil || len(m.target) > len(nearest.target)) {
			nearest = &m
		}
	}
	views := []rootMountView{}
	if nearest != nil {
		rel, _ := filepath.Rel(nearest.target, dir)
		views = append(views, rootMountView{nearest.device, filepath.Join(nearest.source, rel)})
	}
	for _, target := range order {
		if m := top[target]; m.target != dir && pathWithin(m.target, dir) {
			views = append(views, rootMountView{m.device, m.source})
		}
	}
	return views
}
func overlappingMountViews(a, b []rootMountView) bool {
	for _, left := range a {
		for _, right := range b {
			if left.device == right.device && (pathWithin(left.source, right.source) || pathWithin(right.source, left.source)) {
				return true
			}
		}
	}
	return false
}
