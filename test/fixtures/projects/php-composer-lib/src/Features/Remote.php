<?php

declare(strict_types=1);

namespace Corpus\Features;

/** Fetching, later. */
final class Remote
{
    /**
     * @blueprint
     * @return \Fiber<int>
     */
    public static function fetchDouble(int $value): \Fiber
    {
        return new \Fiber(function () use ($value): int {
            $ready = hrtime(true) + 10000000;
            while (hrtime(true) < $ready) {
                \Fiber::suspend();
            }
            return $value * 2;
        });
    }
}
