"""The API half: run from the repository's root with python -m api.main."""

from api.graphs.show_score_vgraph import ShowScore


def main() -> None:
    ShowScore().start()


if __name__ == "__main__":
    main()
