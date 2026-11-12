// The corpus game: greets Ada, then runs the graphs that use the project's features.
#include <iostream>

#include "graphs/Counting.vgraph.h"
#include "graphs/Dividing.vgraph.h"
#include "graphs/Fetching.vgraph.h"
#include "graphs/Greeting.vgraph.h"
#include "graphs/Questing.vgraph.h"

int main() {
    std::cout << Greeting::greet("ada") << '\n';
    Counting().start();
    Dividing().start();
    Questing().start();
    Fetching().start();
    // Delays and futures the graphs wait on.
    vgraph::run_latent_actions();
    return 0;
}
