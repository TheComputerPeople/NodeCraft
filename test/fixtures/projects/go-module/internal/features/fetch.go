package features

import "time"

// FetchDouble gives twice value, a little later.
// @blueprint
func FetchDouble(value int) <-chan int {
	ch := make(chan int, 1)
	go func() {
		time.Sleep(10 * time.Millisecond)
		ch <- value * 2
	}()
	return ch
}
