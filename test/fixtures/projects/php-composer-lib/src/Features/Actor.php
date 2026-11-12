<?php

declare(strict_types=1);

namespace Corpus\Features;

/**
 * Someone in the game, whom graph classes extend.
 *
 * @blueprint
 */
abstract class Actor
{
    /** @blueprint */
    public int $health = 100;

    private string $name;

    /** @blueprint */
    protected function __construct(string $name)
    {
        $this->name = $name;
    }

    /** @blueprint */
    public function greet(): string
    {
        return "{$this->name} has {$this->health}";
    }

    /** @blueprint overridable */
    public function hit(int $damage): void
    {
        $this->health -= $damage;
        echo "{$this->name} takes {$damage}\n";
    }

    abstract protected function describe(): string;

    /** @blueprint */
    public function turn(): void
    {
        echo "{$this->name} is {$this->describe()}\n";
        $this->hit(3);
        echo $this->greet(), "\n";
    }
}
