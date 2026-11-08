namespace Corpus.Game;

/// <summary>A count that grows.</summary>
/// <param name="start">The first count.</param>
/// @blueprint
public class Counter(double start)
{
    /// <summary>The count.</summary>
    /// @blueprint
    public double Count { get; set; } = start;

    /// <summary>Adds to the count.</summary>
    /// <param name="amount">What to add.</param>
    /// <returns>The new count.</returns>
    /// @blueprint
    public double Add(double amount)
    {
        Count += amount;
        return Count;
    }

    /// <summary>Twice the count.</summary>
    /// @blueprint pure
    public double Doubled => Count * 2;
}

/// <summary>A counter that starts ten times higher.</summary>
/// <param name="start">A tenth of the first count.</param>
/// @blueprint
public class BigCounter(double start) : Counter(start * 10)
{
}

/// <summary>The project's functions its graphs use.</summary>
public static class Calculations
{
    /// <summary>Divides a by b.</summary>
    /// <param name="a">The dividend.</param>
    /// <param name="b">The divisor.</param>
    /// <returns>The quotient and the remainder.</returns>
    /// @blueprint
    public static (int quotient, int remainder) Divide(int a, int b)
    {
        return (a / b, a % b);
    }

    /// <summary>The first item.</summary>
    /// <typeparam name="T">The items' type.</typeparam>
    /// <param name="items">The items.</param>
    /// <returns>The first item.</returns>
    /// @blueprint
    public static T First<T>(IReadOnlyList<T> items)
    {
        ArgumentNullException.ThrowIfNull(items);
        return items[0];
    }

    /// <summary>Twice the value, after a moment.</summary>
    /// <param name="value">What to double.</param>
    /// <returns>Twice the value, after a moment.</returns>
    /// @blueprint
    public static async Task<int> FetchDouble(int value)
    {
        await Task.Delay(10).ConfigureAwait(false);
        return value * 2;
    }
}
