"""Run with python -m corpus_game."""

from corpus_game.graphs.counting_vgraph import Counting
from corpus_game.graphs.dividing_vgraph import Dividing
from corpus_game.graphs.fetching_vgraph import Fetching, run_latent_actions
from corpus_game.graphs.firsts_vgraph import Firsts
from corpus_game.graphs.greeting_vgraph import greet


def main() -> None:
    print(greet("ada"))
    Counting().start()
    Dividing().start()
    Firsts().start()
    Fetching().start()
    # Fetching waits for fetch_double: its Completed runs with the graphs' other latent actions.
    run_latent_actions()


if __name__ == "__main__":
    main()
