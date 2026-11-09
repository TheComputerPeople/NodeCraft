<?php

declare(strict_types=1);

namespace App\Services;

/** Formats names for display. */
final class NameFormatter
{
    /**
     * Capitalizes a name's first letter.
     *
     * @blueprint pure
     */
    public static function title(string $name): string
    {
        return ucfirst($name);
    }
}
