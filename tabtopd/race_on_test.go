//go:build race

package main

// raceEnabled: tests run with the race detector, and children of the test
// binary (see TestMain) many times slower.
const raceEnabled = true
