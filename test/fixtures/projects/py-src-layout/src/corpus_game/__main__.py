"""Run with python -m corpus_game."""

from corpus_game.graphs.greeting_vgraph import greet


def main() -> None:
    print(greet("ada"))


if __name__ == "__main__":
    main()
