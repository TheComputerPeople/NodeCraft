// Command corpus greets Ada, then runs the graphs that use the project's features.
package main

import (
	"fmt"

	"example.com/corpus/internal/graphs"
)

func main() {
	fmt.Println(graphs.Greet("ada"))
	graphs.NewCounting().Start()
	graphs.NewDividing().Start()
	graphs.NewFetching().Start()
	// Delays and channels the graphs wait on.
	graphs.VgRunLatentActions()
}
