package main

// Binary preview types and EPUB image policy have one source of truth.
// Generated JavaScript variants support native modules and classic workers.
import (
	_ "embed"
	"encoding/json"
)

//go:generate go run gen_file_types.go
//go:embed file-types.json
var fileTypesJSON []byte

type fileType struct {
	MIME        string `json:"mime"`
	Kind        string `json:"kind"`
	EpubPicture bool   `json:"epubPicture"`
}

var fileTypes = func() map[string]fileType {
	var types map[string]fileType
	if err := json.Unmarshal(fileTypesJSON, &types); err != nil {
		panic(err)
	}
	return types
}()
