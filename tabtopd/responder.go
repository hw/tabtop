package main

import "github.com/coder/websocket"

// tunnelResponder distinguishes opening a stream from completing a request.
// It is owned by one handler and suppresses replies after completion.
type tunnelResponder struct {
	t        msgConn
	accepted bool
	finished bool
}

func (r *tunnelResponder) accept(v map[string]any) bool {
	if r.finished || r.accepted {
		return false
	}
	response := make(map[string]any, len(v)+1)
	for k, value := range v {
		response[k] = value
	}
	response["ok"] = true
	if writeJSON(r.t, response) != nil {
		return false
	}
	r.accepted = true
	return true
}

func (r *tunnelResponder) finish(v map[string]any) bool {
	if r.finished {
		return false
	}
	ok := true
	if !r.accepted {
		ok = r.accept(v)
	} else if v != nil {
		ok = writeJSON(r.t, v) == nil
	}
	r.finished = true
	r.t.Close(websocket.StatusNormalClosure, "")
	return ok
}

func (r *tunnelResponder) fail(message string) {
	if r.finished {
		return
	}
	r.finished = true
	writeJSON(r.t, map[string]any{"error": message})
	r.t.Close(websocket.StatusNormalClosure, "")
}
