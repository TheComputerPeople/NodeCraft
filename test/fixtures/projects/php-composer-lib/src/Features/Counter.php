<?php

declare(strict_types=1);

namespace Corpus\Features;

/** Counts. */
class Counter
{
    /** @blueprint */
    public float $count = 0;

    /** @blueprint */
    public function __construct(float $start)
    {
        $this->count = $start;
    }

    /** @blueprint */
    public function add(float $amount): float
    {
        $this->count += $amount;
        return $this->count;
    }

    /** @blueprint pure */
    public function doubled(): float
    {
        return $this->count * 2;
    }
}
