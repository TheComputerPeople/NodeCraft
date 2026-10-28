// Everyday system utilities (docs/code-as-nodes.md, "More utilities"): the time, as Unix
// milliseconds, a clock for timing, and timestamps written out in ISO 8601 (UTC).
import { FLOAT, STRING, Snippets, UtilityNode, input } from './utility-kit';

// Timestamps from 0001-01-01 to 9999-12-31, the years every language's dates can write.
const RANGE = 'Timestamp must be from year 1 to 9999';
const FIRST = '-62135596800000';
const AFTER_LAST = '253402300800000';

// The date of a timestamp where a language has no UTC date of its own (or none before 1970):
// days since 1970 to year, month and day (Howard Hinnant's civil_from_days, public domain).
const C_LIKE_DATE = String.raw`long long z = days + 719468, era = z / 146097, doe = z - era * 146097;
long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
long long day = doy - (153 * mp + 2) / 5 + 1, month = mp < 10 ? mp + 3 : mp - 9, year = yoe + era * 400 + (month <= 2);`;

export const SYSTEM_UTILITIES: UtilityNode[] = [
  {
    type: 'core:time.now', displayName: 'Now', category: 'Utilities / Time', result: FLOAT, keywords: ['now', 'time', 'date', 'timestamp', 'unix', 'clock'],
    inputs: [],
    description: 'The current time, as Unix milliseconds: whole milliseconds since 1970-01-01 00:00 UTC (Lua counts whole seconds). Format Timestamp writes it out.',
    code: {
      javascript: 'return Date.now();',
      python: 'import time\nreturn float(time.time_ns() // 1000000)',
      csharp: 'return (double)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();',
      cpp: 'return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());',
      rust: 'return std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64;',
      java: 'return (double) System.currentTimeMillis();',
      go: 'return float64(time.Now().UnixMilli())',
      lua: 'return os.time() * 1000',
      gdscript: 'return floorf(Time.get_unix_time_from_system() * 1000.0)',
      ruby: 'return Process.clock_gettime(Process::CLOCK_REALTIME, :millisecond).to_f',
      php: 'return floor(microtime(true) * 1000);'
    }
  },
  {
    type: 'core:time.real-time', displayName: 'Get Accurate Real Time', category: 'Utilities / Time', result: FLOAT, keywords: ['timer', 'elapsed', 'stopwatch', 'seconds', 'monotonic', 'clock'],
    inputs: [],
    description: 'Seconds from a fixed moment (not a date), on a clock that never goes back: subtract two readings to time something. Lua has only processor time (os.clock).',
    code: {
      javascript: 'return /** @type {any} */ (globalThis).performance.now() / 1000;',
      typescript: 'return (globalThis as any).performance.now() / 1000;',
      python: 'import time\nreturn time.monotonic()',
      csharp: 'return System.Diagnostics.Stopwatch.GetTimestamp() / (double)System.Diagnostics.Stopwatch.Frequency;',
      cpp: 'return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();',
      rust: 'static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();\nreturn START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64();',
      java: 'return System.nanoTime() / 1e9;',
      // The runtime's clock for Delay: seconds since the program started.
      go: 'return vgLatentClock()',
      lua: 'return os.clock()',
      gdscript: 'return Time.get_ticks_usec() / 1000000.0',
      ruby: 'return Process.clock_gettime(Process::CLOCK_MONOTONIC)',
      php: 'return hrtime(true) / 1e9;'
    }
  },
  {
    type: 'core:time.format-timestamp', displayName: 'Format Timestamp', category: 'Utilities / Time', result: STRING, keywords: ['iso 8601', 'date', 'time', 'format', 'utc', 'timestamp'],
    inputs: [input('ms', 'Unix Milliseconds', FLOAT, 0)],
    description: 'The time, given in Unix milliseconds, written in ISO 8601 in UTC: 2026-10-28T09:30:00.000Z. A fraction of a millisecond is dropped. Times before year 1 or after 9999 stop the run with an error.',
    code: withRange({
      javascript: 'return new Date(Math.floor(ms)).toISOString();',
      python: [
        'import datetime, math',
        't = datetime.datetime(1970, 1, 1) + datetime.timedelta(milliseconds=math.floor(ms))',
        'return f"{t.year:04d}-{t.month:02d}-{t.day:02d}T{t.hour:02d}:{t.minute:02d}:{t.second:02d}.{t.microsecond // 1000:03d}Z"'
      ].join('\n'),
      csharp: 'return DateTimeOffset.FromUnixTimeMilliseconds((long)Math.Floor(ms)).UtcDateTime.ToString("yyyy-MM-dd\'T\'HH:mm:ss.fff\'Z\'", CultureInfo.InvariantCulture);',
      cpp: [
        'long long total = static_cast<long long>(std::floor(ms));',
        'long long days = total / 86400000, rest = total % 86400000;',
        'if (rest < 0) {',
        '    rest += 86400000;',
        '    days--;',
        '}',
        C_LIKE_DATE,
        'char text[32];',
        'std::snprintf(text, sizeof text, "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%03lldZ", year, month, day, rest / 3600000, rest / 60000 % 60, rest / 1000 % 60, rest % 1000);',
        'return std::string(text);'
      ].join('\n'),
      rust: [
        'let total = ms.floor() as i64;',
        'let (days, rest) = (total.div_euclid(86400000), total.rem_euclid(86400000));',
        'let z = days + 719468;',
        'let era = z / 146097;',
        'let doe = z - era * 146097;',
        'let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;',
        'let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);',
        'let mp = (5 * doy + 2) / 153;',
        'let day = doy - (153 * mp + 2) / 5 + 1;',
        'let month = if mp < 10 { mp + 3 } else { mp - 9 };',
        'let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };',
        'return format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", year, month, day, rest / 3600000, rest / 60000 % 60, rest / 1000 % 60, rest % 1000);'
      ].join('\n'),
      java: 'return java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd\'T\'HH:mm:ss.SSS\'Z\'").withZone(java.time.ZoneOffset.UTC).format(java.time.Instant.ofEpochMilli((long) Math.floor(ms)));',
      go: 'return time.UnixMilli(int64(math.Floor(ms))).UTC().Format("2006-01-02T15:04:05.000Z")',
      lua: [
        'local total = math.floor(ms)',
        'local days, rest = total // 86400000, total % 86400000',
        'local z = days + 719468',
        'local era = z // 146097',
        'local doe = z - era * 146097',
        'local yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365',
        'local doy = doe - (365 * yoe + yoe // 4 - yoe // 100)',
        'local mp = (5 * doy + 2) // 153',
        'local day = doy - (153 * mp + 2) // 5 + 1',
        'local month = mp < 10 and mp + 3 or mp - 9',
        'local year = yoe + era * 400 + (month <= 2 and 1 or 0)',
        'return string.format("%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", year, month, day, rest // 3600000, rest // 60000 % 60, rest // 1000 % 60, rest % 1000)'
      ].join('\n'),
      gdscript: [
        'var total := floori(ms)',
        'var millis := posmod(total, 1000)',
        'return Time.get_datetime_string_from_unix_time((total - millis) / 1000) + ".%03dZ" % millis'
      ].join('\n'),
      ruby: 'total = ms.floor\nreturn Time.at(total.div(1000), total % 1000, :millisecond).utc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")',
      php: [
        '$total = (int) floor($ms);',
        '$millis = ($total % 1000 + 1000) % 1000;',
        "return gmdate('Y-m-d\\TH:i:s', intdiv($total - $millis, 1000)) . sprintf('.%03dZ', $millis);"
      ].join('\n')
    })
  }
];

// Format Timestamp's range check, first in each language (NaN fails it too).
function withRange(snippets: Snippets): Snippets {
  const check: Snippets = {
    javascript: `if (!(ms >= ${FIRST} && ms < ${AFTER_LAST})) throw new Error('${RANGE}');`,
    python: `if not (${FIRST} <= ms < ${AFTER_LAST}):\n    raise ValueError("${RANGE}")`,
    csharp: `if (!(ms >= ${FIRST}.0 && ms < ${AFTER_LAST}.0)) throw new ArgumentException("${RANGE}");`,
    cpp: `if (!(ms >= ${FIRST}.0 && ms < ${AFTER_LAST}.0)) throw std::invalid_argument("${RANGE}");`,
    rust: `if !(ms >= ${FIRST}.0 && ms < ${AFTER_LAST}.0) { panic!("${RANGE}"); }`,
    java: `if (!(ms >= ${FIRST}.0 && ms < ${AFTER_LAST}.0)) throw new IllegalArgumentException("${RANGE}");`,
    go: `if !(ms >= ${FIRST} && ms < ${AFTER_LAST}) {\n\tVgFail("${RANGE}")\n}`,
    lua: `if not (ms >= ${FIRST} and ms < ${AFTER_LAST}) then error("${RANGE}", 0) end`,
    gdscript: `if not (ms >= ${FIRST} and ms < ${AFTER_LAST}):\n\treturn vg.fail("${RANGE}")`,
    ruby: `raise ArgumentError, "${RANGE}" unless ms >= ${FIRST} && ms < ${AFTER_LAST}`,
    php: `if (!($ms >= ${FIRST} && $ms < ${AFTER_LAST})) {\n    throw new \\InvalidArgumentException('${RANGE}');\n}`
  };
  return Object.fromEntries(Object.entries(snippets).map(([language, code]) => [language, `${check[language]}\n${code}`]));
}
