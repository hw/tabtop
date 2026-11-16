package main

import "testing"

func TestRootMountAliases(t *testing.T) {
	mounts := []rootMount{
		{device: "0:1", source: "/", target: "/"},
		{device: "8:1", source: "/storage", target: "/data"},
		{device: "8:1", source: "/storage/documents", target: "/documents"},
		{device: "8:1", source: "/separate", target: "/separate"},
		{device: "0:7", source: "/", target: "/data/network"},
		{device: "0:7", source: "/reports", target: "/reports"},
	}
	for _, pair := range [][2]string{{"/data", "/documents"}, {"/data/sub", "/data/sub/deeper"}, {"/data", "/reports"}} {
		if !overlappingMountViews(mountViews(pair[0], mounts), mountViews(pair[1], mounts)) {
			t.Errorf("mount alias overlap missed: %v", pair)
		}
	}
	for _, pair := range [][2]string{{"/documents", "/separate"}, {"/data/sub", "/documents"}, {"/data", "/outside"}} {
		if overlappingMountViews(mountViews(pair[0], mounts), mountViews(pair[1], mounts)) {
			t.Errorf("unrelated roots overlap: %v", pair)
		}
	}
}

// Where one mount is over another, the top one is what's seen there.
func TestStackedMountsUseTheTopOne(t *testing.T) {
	mounts := []rootMount{
		{device: "0:1", source: "/", target: "/"},
		{device: "8:1", source: "/", target: "/data"},
		{device: "0:9", source: "/", target: "/srv/a"},
		{device: "8:1", source: "/shared", target: "/srv/a"}, // a bind, over the tmpfs
		{device: "8:1", source: "/x", target: "/srv/b"},
		{device: "0:10", source: "/", target: "/srv/b"}, // a tmpfs, over the bind
	}
	if !overlappingMountViews(mountViews("/srv/a", mounts), mountViews("/data/shared", mounts)) {
		t.Error("a bind over another mount not seen as an alias")
	}
	if overlappingMountViews(mountViews("/srv/b", mounts), mountViews("/data/x", mounts)) {
		t.Error("a bind hidden under another mount seen as an alias")
	}
	if overlappingMountViews(mountViews("/srv", mounts), mountViews("/data/x", mounts)) {
		t.Error("a hidden bind inside a root seen as an alias")
	}
}
