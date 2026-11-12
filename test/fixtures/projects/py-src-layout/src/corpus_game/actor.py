"""A class of the game's that graph classes extend."""

from abc import ABC, abstractmethod


class Actor(ABC):
    """@blueprint"""

    health: int = 100
    """@blueprint"""

    def __init__(self, name: str) -> None:
        """@blueprint"""
        self.name = name
        self.health = 100

    def greet(self) -> str:
        """@blueprint"""
        return f"{self.name} has {self.health}"

    def hit(self, damage: int) -> None:
        """@blueprint overridable"""
        self.health -= damage
        print(f"{self.name} takes {damage}")

    @abstractmethod
    def describe(self) -> str:
        """@blueprint"""

    def turn(self) -> None:
        """@blueprint"""
        print(f"{self.name} is {self.describe()}")
        self.hit(3)
        print(self.greet())
