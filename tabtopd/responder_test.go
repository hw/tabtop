package main

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"reflect"
	"testing"
)

type responseRecorder struct {
	msgConn
	messages []map[string]any
	closes   int
}

func (c *responseRecorder) Write(_ context.Context, kind websocket.MessageType, p []byte) error {
	var message map[string]any
	if err := json.Unmarshal(p, &message); err != nil {
		return err
	}
	c.messages = append(c.messages, message)
	return nil
}
func (c *responseRecorder) Close(websocket.StatusCode, string) error { c.closes++; return nil }

func TestResponderOneShotAndStream(t *testing.T) {
	for _, stream := range []bool{false, true} {
		c := &responseRecorder{}
		r := &tunnelResponder{t: c}
		input := map[string]any{"name": "file"}
		if stream {
			if !r.accept(input) {
				t.Fatal("accept failed")
			}
			if c.closes != 0 {
				t.Fatal("accept closed stream")
			}
			r.finish(map[string]any{"done": true})
		} else {
			r.finish(input)
		}
		if _, ok := input["ok"]; ok {
			t.Fatal("mutated caller's response")
		}
		r.finish(nil)
		r.fail("late error")
		if r.accept(nil) || c.closes != 1 {
			t.Fatal("responded after completion")
		}
		want := []map[string]any{{"ok": true, "name": "file"}}
		if stream {
			want = append(want, map[string]any{"done": true})
		}
		if !reflect.DeepEqual(c.messages, want) {
			t.Fatalf("responses %v, want %v", c.messages, want)
		}
	}
}

func TestResponderFailureAfterAcceptance(t *testing.T) {
	c := &responseRecorder{}
	r := &tunnelResponder{t: c}
	r.accept(nil)
	r.fail("disk full")
	r.finish(nil)
	if c.closes != 1 || len(c.messages) != 2 || c.messages[1]["error"] != "disk full" {
		t.Fatalf("responses: %v, closes %d", c.messages, c.closes)
	}
}
