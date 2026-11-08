"""The package's own classes and functions its graphs use."""

import asyncio
from typing import TypeVar

T = TypeVar("T")


class Counter:
    """A count that grows."""

    count: float = 0
    """@blueprint"""

    def __init__(self, start: float) -> None:
        """@blueprint"""
        self.count = start

    def add(self, amount: float) -> float:
        """@blueprint"""
        self.count += amount
        return self.count

    @property
    def doubled(self) -> float:
        """@blueprint pure"""
        return self.count * 2


class BigCounter(Counter):
    """A counter that starts ten times higher."""

    def __init__(self, start: float) -> None:
        """@blueprint"""
        super().__init__(start * 10)


def divide(a: int, b: int) -> tuple[int, int]:
    """@blueprint
    @outputs quotient remainder"""
    return a // b, a % b


def first(items: list[T]) -> T:
    """@blueprint"""
    return items[0]


async def fetch_double(value: int) -> int:
    """@blueprint"""
    await asyncio.sleep(0.01)
    return value * 2
