"""A class from the project's code, used from graphs (docs/node-authoring.md, gap 2): its
constructor, methods and attribute become nodes with a Target pin."""

import asyncio


class Trainee:
    """Someone training at the dojo."""

    health: float = 0
    """How much health the trainee has.

    @blueprint"""

    def __init__(self, start: float) -> None:
        """@blueprint"""
        self.health = start

    def train(self, hours: float) -> float:
        """Trains for some hours, gaining a point of health an hour.

        @blueprint"""
        self.health += hours
        return self.health

    def split(self) -> tuple[float, float]:
        """The health's tens and units, as two outputs (gap 3).

        @blueprint
        @outputs tens units"""
        return self.health // 10, self.health % 10

    async def rest(self, seconds: float) -> float:
        """Rests a while, then gives the health: a latent node (gap 4).

        @blueprint"""
        await asyncio.sleep(seconds)
        return self.health
