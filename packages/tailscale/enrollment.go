package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// Only the first line carries credentials. Return the same buffered reader so
// the parent-death EOF monitor also sees any bytes buffered during enrollment.
func readEnrollment(input io.Reader, enabled bool) (io.Reader, string, error) {
	if !enabled {
		return input, "", nil
	}
	reader := bufio.NewReaderSize(input, 16384)
	line, err := reader.ReadSlice('\n')
	if err != nil {
		return reader, "", errors.New("invalid enrollment message")
	}
	var request struct {
		AuthKey string `json:"authKey"`
	}
	if err := json.Unmarshal(line, &request); err != nil {
		return reader, "", errors.New("invalid enrollment message")
	}
	key := strings.TrimSpace(request.AuthKey)
	if len(key) == 0 || len(key) > 4096 {
		return reader, "", errors.New("invalid enrollment credentials")
	}
	for _, char := range key {
		if char < '!' || char > '~' {
			return reader, "", errors.New("invalid enrollment credentials")
		}
	}
	return reader, key, nil
}
