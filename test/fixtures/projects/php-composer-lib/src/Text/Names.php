<?php

declare(strict_types=1);

namespace Corpus\Text;

/** Formats names. */
final class Names
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
