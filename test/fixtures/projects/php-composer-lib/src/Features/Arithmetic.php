<?php

declare(strict_types=1);

namespace Corpus\Features;

/** Division. */
final class Arithmetic
{
    /**
     * @blueprint
     * @return array{quotient: int, remainder: int}
     */
    public static function divide(int $a, int $b): array
    {
        return ['quotient' => intdiv($a, $b), 'remainder' => $a % $b];
    }
}
