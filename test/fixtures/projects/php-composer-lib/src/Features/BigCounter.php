<?php

declare(strict_types=1);

namespace Corpus\Features;

/** Counts in tens. */
class BigCounter extends Counter
{
    /** @blueprint */
    public function __construct(float $start)
    {
        parent::__construct($start * 10);
    }
}
