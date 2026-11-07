#!/usr/bin/env python
"""Django's command-line utility, without Django: "greet <name>" runs the game's graph."""

import sys

from game.graphs.greeting_vgraph import greet


def main() -> None:
    if sys.argv[1:2] == ["greet"]:
        print(greet(sys.argv[2]))


if __name__ == "__main__":
    main()
