"""A class from the project's code, used from graphs (docs/node-authoring.md, gap 2): its
constructor, methods and attribute become nodes with a Target pin."""

import asyncio


class Tally:
    """A running total."""

    total: float = 0
    """The total so far.

    @blueprint"""

    def __init__(self, start: float) -> None:
        """@blueprint"""
        self.total = start

    def add(self, amount: float) -> float:
        """Adds an amount to the total, and gives the new total.

        @blueprint"""
        self.total += amount
        return self.total

    def split(self) -> tuple[float, float]:
        """The total's tens and units, as two outputs (gap 3).

        @blueprint
        @outputs tens units"""
        return self.total // 10, self.total % 10

    async def settle(self, seconds: float) -> float:
        """Waits a while, then gives the total: a latent node (gap 4).

        @blueprint"""
        await asyncio.sleep(seconds)
        return self.total
