<?php

declare(strict_types=1);

namespace Corpus\Features;

/** Fetching, later. */
final class Remote
{
    /**
     * @blueprint
     * @return \Fiber<mixed, mixed, int, mixed>
     */
    public static function fetchDouble(int $value): \Fiber
    {
        /** @var \Fiber<mixed, mixed, int, mixed> $fiber */
        $fiber = new \Fiber(function () use ($value): int {
            $ready = hrtime(true) + 10000000;
            while (hrtime(true) < $ready) {
                \Fiber::suspend();
            }
            return $value * 2;
        });
        return $fiber;
    }
}
