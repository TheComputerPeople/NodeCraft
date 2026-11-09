// Package features is what the graphs use beyond plain functions.
package features

// Counter counts.
type Counter struct {
	// @blueprint
	Count float64
}

// NewCounter makes a Counter starting at start.
// @blueprint
func NewCounter(start float64) *Counter {
	return &Counter{Count: start}
}

// Add adds amount and gives the new count.
// @blueprint
func (c *Counter) Add(amount float64) float64 {
	c.Count += amount
	return c.Count
}

// Doubled is twice the count.
// @blueprint pure
func (c *Counter) Doubled() float64 {
	return c.Count * 2
}

// BigCounter counts in tens.
type BigCounter struct {
	count float64
}

// NewBigCounter makes a BigCounter starting at ten times start.
// @blueprint
func NewBigCounter(start float64) *BigCounter {
	return &BigCounter{count: start * 10}
}

// Add adds amount and gives the new count.
// @blueprint
func (b *BigCounter) Add(amount float64) float64 {
	b.count += amount
	return b.count
}
