// Command app greets Ada through the Greeting graph.
package main

import (
	"fmt"

	"example.com/app/graphs"
)

func main() {
	fmt.Println(graphs.Greet("ada"))
}
