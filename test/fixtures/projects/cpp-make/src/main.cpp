// Greets Ada through the Greeting graph.
#include <iostream>

#include "graphs/Greeting.vgraph.h"

int main() {
    std::cout << Greeting::greet("ada") << '\n';
    return 0;
}
