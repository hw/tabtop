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

func (r *tunnelResponder) fail(message string) { r.failCode(message, "") }

// failCode fails with message, and code, if it's set: what the page may
// act on (see TunnelError.code), not having to read the message.
func (r *tunnelResponder) failCode(message, code string) {
	if r.finished {
		return
	}
	r.finished = true
	reply := map[string]any{"error": message}
	if code != "" {
		reply["code"] = code
	}
	writeJSON(r.t, reply)
	r.t.Close(websocket.StatusNormalClosure, "")
}
