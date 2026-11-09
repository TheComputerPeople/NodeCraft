// Everyday system utilities (docs/code-as-nodes.md, "More utilities"): the time, as Unix
// milliseconds, a clock for timing, timestamps written out in ISO 8601 (UTC), Base64 and URL
// encoding, and UUIDs.
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

// ---- Encoding and IDs -----------------------------------------------------------------------------
//
// Base64 and URL encoding work on the text's UTF-8 bytes. Decoding gives text again, so bytes that
// aren't UTF-8 stop the run (where languages would otherwise put in replacement characters, each
// its own way), as does input that isn't Base64 or URL encoding.

const BASE64_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const NOT_BASE64 = 'Not valid Base64';
const NOT_URL = 'Not valid URL encoding';
const NOT_UTF8 = 'Not UTF-8 text';

// Whether a string's bytes are UTF-8 (no overlong forms, surrogates or code points past U+10FFFF).
const CPP_IS_UTF8 = String.raw`auto isUtf8 = [](const std::string& s) {
    for (std::size_t i = 0; i < s.size();) {
        unsigned char c = s[i];
        std::size_t n = c < 0x80 ? 1 : c >= 0xC2 && c <= 0xDF ? 2 : c >= 0xE0 && c <= 0xEF ? 3 : c >= 0xF0 && c <= 0xF4 ? 4 : 0;
        if (n == 0 || i + n > s.size()) return false;
        unsigned long code = n == 1 ? c : c & (0xFF >> (n + 1));
        for (std::size_t k = 1; k < n; k++) {
            unsigned char next = s[i + k];
            if ((next & 0xC0) != 0x80) return false;
            code = code << 6 | (next & 0x3F);
        }
        if ((n == 3 && (code < 0x800 || (code >= 0xD800 && code <= 0xDFFF))) || (n == 4 && (code < 0x10000 || code > 0x10FFFF))) return false;
        i += n;
    }
    return true;
};`;

export const ENCODING_UTILITIES: UtilityNode[] = [
  {
    type: 'core:encoding.base64-encode', displayName: 'Base64 Encode', category: 'Utilities / Encoding', result: STRING, keywords: ['base64', 'encode', 'btoa'],
    inputs: [input('text', 'Text', STRING, '')], description: 'The text\'s UTF-8 bytes in Base64 (the standard alphabet, with = padding).',
    code: {
      javascript: [
        'const bytes = new (/** @type {any} */ (globalThis).TextEncoder)().encode(text);',
        "let binary = '';",
        'for (const byte of bytes) binary += String.fromCharCode(byte);',
        'return /** @type {any} */ (globalThis).btoa(binary);'
      ].join('\n'),
      typescript: [
        'const bytes: Uint8Array = new (globalThis as any).TextEncoder().encode(text);',
        "let binary = '';",
        'for (const byte of bytes) binary += String.fromCharCode(byte);',
        'return (globalThis as any).btoa(binary);'
      ].join('\n'),
      python: 'import base64\nreturn base64.b64encode(text.encode("utf-8")).decode("ascii")',
      csharp: 'return Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(text));',
      cpp: [
        `static const char* digits = "${BASE64_DIGITS}";`,
        'std::string result;',
        'for (std::size_t i = 0; i < text.size(); i += 3) {',
        '    unsigned long chunk = static_cast<unsigned long>(static_cast<unsigned char>(text[i])) << 16;',
        '    if (i + 1 < text.size()) chunk |= static_cast<unsigned long>(static_cast<unsigned char>(text[i + 1])) << 8;',
        '    if (i + 2 < text.size()) chunk |= static_cast<unsigned char>(text[i + 2]);',
        '    result += digits[chunk >> 18 & 63];',
        '    result += digits[chunk >> 12 & 63];',
        "    result += i + 1 < text.size() ? digits[chunk >> 6 & 63] : '=';",
        "    result += i + 2 < text.size() ? digits[chunk & 63] : '=';",
        '}',
        'return result;'
      ].join('\n'),
      rust: [
        `const DIGITS: &[u8] = b"${BASE64_DIGITS}";`,
        'let mut result = String::new();',
        'for chunk in text.as_bytes().chunks(3) {',
        '    let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;',
        '    result.push(DIGITS[(n >> 18 & 63) as usize] as char);',
        '    result.push(DIGITS[(n >> 12 & 63) as usize] as char);',
        "    result.push(if chunk.len() > 1 { DIGITS[(n >> 6 & 63) as usize] as char } else { '=' });",
        "    result.push(if chunk.len() > 2 { DIGITS[(n & 63) as usize] as char } else { '=' });",
        '}',
        'return result;'
      ].join('\n'),
      java: 'return java.util.Base64.getEncoder().encodeToString(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));',
      go: 'return base64.StdEncoding.EncodeToString([]byte(text))',
      lua: [
        `local digits = "${BASE64_DIGITS}"`,
        'local function digit(v) return digits:sub(v + 1, v + 1) end',
        'local out = {}',
        'for i = 1, #text, 3 do',
        '  local a, b, c = text:byte(i, i + 2)',
        '  local n = a << 16 | (b or 0) << 8 | (c or 0)',
        '  out[#out + 1] = digit(n >> 18 & 63) .. digit(n >> 12 & 63) .. (b and digit(n >> 6 & 63) or "=") .. (c and digit(n & 63) or "=")',
        'end',
        'return table.concat(out)'
      ].join('\n'),
      gdscript: 'return Marshalls.utf8_to_base64(text)',
      ruby: 'return [text].pack("m0")',
      php: 'return base64_encode($text);'
    }
  },
  {
    type: 'core:encoding.base64-decode', displayName: 'Base64 Decode', category: 'Utilities / Encoding', result: STRING, keywords: ['base64', 'decode', 'atob'],
    inputs: [input('text', 'Base64', STRING, '')],
    description: 'The text whose UTF-8 bytes the Base64 spells (the standard alphabet, with = padding). Anything else, or bytes that aren\'t UTF-8 text, stops the run with an error.',
    code: {
      javascript: [
        `if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('${NOT_BASE64}');`,
        'const binary = /** @type {any} */ (globalThis).atob(text);',
        'const bytes = Uint8Array.from(binary, (/** @type {string} */ c) => c.charCodeAt(0));',
        'try {',
        "  return new (/** @type {any} */ (globalThis).TextDecoder)('utf-8', { fatal: true }).decode(bytes);",
        '} catch {',
        `  throw new Error('${NOT_UTF8}');`,
        '}'
      ].join('\n'),
      typescript: [
        `if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('${NOT_BASE64}');`,
        'const binary: string = (globalThis as any).atob(text);',
        'const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));',
        'try {',
        "  return new (globalThis as any).TextDecoder('utf-8', { fatal: true }).decode(bytes) as string;",
        '} catch {',
        `  throw new Error('${NOT_UTF8}');`,
        '}'
      ].join('\n'),
      python: [
        'import base64, re',
        'if len(text) % 4 or not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", text):',
        `    raise ValueError("${NOT_BASE64}")`,
        'try:',
        '    return base64.b64decode(text).decode("utf-8")',
        'except UnicodeDecodeError:',
        `    raise ValueError("${NOT_UTF8}") from None`
      ].join('\n'),
      csharp: [
        `if (text.Length % 4 != 0 || !System.Text.RegularExpressions.Regex.IsMatch(text, @"^[A-Za-z0-9+/]*={0,2}\\z")) throw new FormatException("${NOT_BASE64}");`,
        'try',
        '{',
        '    return new System.Text.UTF8Encoding(false, true).GetString(Convert.FromBase64String(text));',
        '}',
        'catch (System.Text.DecoderFallbackException)',
        '{',
        `    throw new FormatException("${NOT_UTF8}");`,
        '}'
      ].join('\n'),
      cpp: [
        `if (text.size() % 4 != 0 || !std::regex_match(text, std::regex("[A-Za-z0-9+/]*={0,2}"))) throw std::invalid_argument("${NOT_BASE64}");`,
        `static const std::string digits = "${BASE64_DIGITS}";`,
        'std::string result;',
        // std::size_t, what find gives (unsigned long is 32 bits on Windows: -Wconversion).
        'std::size_t bits = 0;',
        'int count = 0;',
        'for (char c : text) {',
        "    if (c == '=') break;",
        '    bits = bits << 6 | digits.find(c);',
        '    count += 6;',
        '    if (count >= 8) {',
        '        count -= 8;',
        '        result += static_cast<char>(bits >> count & 0xFF);',
        '        bits &= (std::size_t{1} << count) - 1;',
        '    }',
        '}',
        CPP_IS_UTF8,
        `if (!isUtf8(result)) throw std::invalid_argument("${NOT_UTF8}");`,
        'return result;'
      ].join('\n'),
      rust: [
        "let body = text.trim_end_matches('=');",
        `if text.len() % 4 != 0 || text.len() - body.len() > 2 || !body.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/') { panic!("${NOT_BASE64}"); }`,
        `const DIGITS: &str = "${BASE64_DIGITS}";`,
        'let mut bytes = Vec::new();',
        'let (mut bits, mut count) = (0u32, 0);',
        'for c in body.chars() {',
        '    bits = bits << 6 | DIGITS.find(c).unwrap() as u32;',
        '    count += 6;',
        '    if count >= 8 {',
        '        count -= 8;',
        '        bytes.push((bits >> count & 0xFF) as u8);',
        '        bits &= (1 << count) - 1;',
        '    }',
        '}',
        `return String::from_utf8(bytes).unwrap_or_else(|_| panic!("${NOT_UTF8}"));`
      ].join('\n'),
      java: [
        `if (text.length() % 4 != 0 || !text.matches("[A-Za-z0-9+/]*={0,2}")) throw new IllegalArgumentException("${NOT_BASE64}");`,
        'try {',
        '    return java.nio.charset.StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(java.util.Base64.getDecoder().decode(text))).toString();',
        '} catch (java.nio.charset.CharacterCodingException e) {',
        `    throw new IllegalArgumentException("${NOT_UTF8}");`,
        '}'
      ].join('\n'),
      go: [
        'body := strings.TrimRight(text, "=")',
        `if len(text)%4 != 0 || len(text)-len(body) > 2 || strings.Trim(body, "${BASE64_DIGITS}") != "" {`,
        `\tVgFail("${NOT_BASE64}")`,
        '}',
        'bytes, _ := base64.StdEncoding.DecodeString(text)',
        'if !utf8.Valid(bytes) {',
        `\tVgFail("${NOT_UTF8}")`,
        '}',
        'return string(bytes)'
      ].join('\n'),
      lua: [
        'local body = text:gsub("=+$", "")',
        `if #text % 4 ~= 0 or #text - #body > 2 or body:find("[^%w+/]") then error("${NOT_BASE64}", 0) end`,
        `local digits = "${BASE64_DIGITS}"`,
        'local out, bits, count = {}, 0, 0',
        'for i = 1, #body do',
        '  bits = bits << 6 | (digits:find(body:sub(i, i), 1, true) - 1)',
        '  count = count + 6',
        '  if count >= 8 then',
        '    count = count - 8',
        '    out[#out + 1] = string.char(bits >> count & 0xFF)',
        '    bits = bits & ((1 << count) - 1)',
        '  end',
        'end',
        'local result = table.concat(out)',
        `if not utf8.len(result) then error("${NOT_UTF8}", 0) end`,
        'return result'
      ].join('\n'),
      gdscript: [
        'var body := text.rstrip("=")',
        'if text.length() % 4 != 0 or text.length() - body.length() > 2 or RegEx.create_from_string("[^A-Za-z0-9+/]").search(body) != null:',
        `\treturn vg.fail("${NOT_BASE64}")`,
        'var bytes := Marshalls.base64_to_raw(text)',
        'var result := bytes.get_string_from_utf8()',
        'if result.to_utf8_buffer() != bytes:',
        `\treturn vg.fail("${NOT_UTF8}")`,
        'return result'
      ].join('\n'),
      ruby: [
        'body = text.sub(/=+\\z/, "")',
        `raise ArgumentError, "${NOT_BASE64}" if text.length % 4 != 0 || text.length - body.length > 2 || body.match?(/[^A-Za-z0-9+\\/]/)`,
        'result = text.unpack1("m0").force_encoding("UTF-8")',
        `raise ArgumentError, "${NOT_UTF8}" unless result.valid_encoding?`,
        'return result'
      ].join('\n'),
      php: [
        "$body = rtrim($text, '=');",
        "if (strlen($text) % 4 !== 0 || strlen($text) - strlen($body) > 2 || preg_match('/[^A-Za-z0-9+\\/]/', $body)) {",
        `    throw new \\InvalidArgumentException('${NOT_BASE64}');`,
        '}',
        '$result = base64_decode($text, true);',
        "if (!mb_check_encoding($result, 'UTF-8')) {",
        `    throw new \\InvalidArgumentException('${NOT_UTF8}');`,
        '}',
        'return $result;'
      ].join('\n')
    }
  },
  {
    type: 'core:encoding.url-encode', displayName: 'URL Encode', category: 'Utilities / Encoding', result: STRING, keywords: ['url', 'percent', 'encode', 'escape', 'uri', 'query'],
    inputs: [input('text', 'Text', STRING, '')],
    description: 'The text with every UTF-8 byte except letters, digits and - _ . ~ written as %XX (a space is %20), for a part of a URL.',
    code: {
      javascript: "return encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());",
      python: 'import urllib.parse\nreturn urllib.parse.quote(text, safe="")',
      csharp: 'return Uri.EscapeDataString(text);',
      cpp: [
        'static const char* hex = "0123456789ABCDEF";',
        'std::string result;',
        'for (unsigned char c : text) {',
        "    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {",
        '        result += static_cast<char>(c);',
        '    } else {',
        "        result += '%';",
        '        result += hex[c >> 4];',
        '        result += hex[c & 15];',
        '    }',
        '}',
        'return result;'
      ].join('\n'),
      rust: [
        'let mut result = String::new();',
        'for c in text.bytes() {',
        '    if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) { result.push(c as char); } else { result.push_str(&format!("%{:02X}", c)); }',
        '}',
        'return result;'
      ].join('\n'),
      java: 'return java.net.URLEncoder.encode(text, java.nio.charset.StandardCharsets.UTF_8).replace("+", "%20").replace("*", "%2A").replace("%7E", "~");',
      go: 'return strings.ReplaceAll(url.QueryEscape(text), "+", "%20")',
      lua: 'return (text:gsub("[^%w%-_%.~]", function(c) return string.format("%%%02X", c:byte()) end))',
      gdscript: 'return text.uri_encode()',
      ruby: 'return text.b.gsub(/[^A-Za-z0-9\\-_.~]/) { |c| format("%%%02X", c.ord) }.force_encoding("UTF-8")',
      php: 'return rawurlencode($text);'
    }
  },
  {
    type: 'core:encoding.url-decode', displayName: 'URL Decode', category: 'Utilities / Encoding', result: STRING, keywords: ['url', 'percent', 'decode', 'unescape', 'uri', 'query'],
    inputs: [input('text', 'Text', STRING, '')],
    description: 'The text with each %XX turned back into its byte (+ stays +). A % without two hex digits, or bytes that aren\'t UTF-8 text, stops the run with an error.',
    code: {
      javascript: [
        `if (/%(?![0-9A-Fa-f]{2})/.test(text)) throw new Error('${NOT_URL}');`,
        'try {',
        '  return decodeURIComponent(text);',
        '} catch {',
        `  throw new Error('${NOT_UTF8}');`,
        '}'
      ].join('\n'),
      python: [
        'import re, urllib.parse',
        'if re.search(r"%(?![0-9A-Fa-f]{2})", text):',
        `    raise ValueError("${NOT_URL}")`,
        'try:',
        '    return urllib.parse.unquote(text, errors="strict")',
        'except UnicodeDecodeError:',
        `    raise ValueError("${NOT_UTF8}") from None`
      ].join('\n'),
      csharp: [
        `if (System.Text.RegularExpressions.Regex.IsMatch(text, "%(?![0-9A-Fa-f]{2})")) throw new FormatException("${NOT_URL}");`,
        'var raw = System.Text.Encoding.UTF8.GetBytes(text);',
        'var bytes = new List<byte>();',
        'for (var i = 0; i < raw.Length; i++)',
        '{',
        "    if (raw[i] == '%')",
        '    {',
        '        bytes.Add(Convert.ToByte(System.Text.Encoding.ASCII.GetString(raw, i + 1, 2), 16));',
        '        i += 2;',
        '    }',
        '    else bytes.Add(raw[i]);',
        '}',
        'try',
        '{',
        '    return new System.Text.UTF8Encoding(false, true).GetString(bytes.ToArray());',
        '}',
        'catch (System.Text.DecoderFallbackException)',
        '{',
        `    throw new FormatException("${NOT_UTF8}");`,
        '}'
      ].join('\n'),
      cpp: [
        'std::string result;',
        'for (std::size_t i = 0; i < text.size(); i++) {',
        "    if (text[i] != '%') {",
        '        result += text[i];',
        '        continue;',
        '    }',
        `    if (i + 2 >= text.size() || !std::isxdigit(static_cast<unsigned char>(text[i + 1])) || !std::isxdigit(static_cast<unsigned char>(text[i + 2]))) throw std::invalid_argument("${NOT_URL}");`,
        '    result += static_cast<char>(std::stoi(text.substr(i + 1, 2), nullptr, 16));',
        '    i += 2;',
        '}',
        CPP_IS_UTF8,
        `if (!isUtf8(result)) throw std::invalid_argument("${NOT_UTF8}");`,
        'return result;'
      ].join('\n'),
      rust: [
        'let bytes = text.as_bytes();',
        'let mut out = Vec::new();',
        'let mut i = 0;',
        'while i < bytes.len() {',
        "    if bytes[i] == b'%' {",
        `        if i + 2 >= bytes.len() || !bytes[i + 1].is_ascii_hexdigit() || !bytes[i + 2].is_ascii_hexdigit() { panic!("${NOT_URL}"); }`,
        '        out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap());',
        '        i += 3;',
        '    } else {',
        '        out.push(bytes[i]);',
        '        i += 1;',
        '    }',
        '}',
        `return String::from_utf8(out).unwrap_or_else(|_| panic!("${NOT_UTF8}"));`
      ].join('\n'),
      java: [
        `if (java.util.regex.Pattern.compile("%(?![0-9A-Fa-f]{2})").matcher(text).find()) throw new IllegalArgumentException("${NOT_URL}");`,
        'var raw = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);',
        'var out = new java.io.ByteArrayOutputStream();',
        'for (int i = 0; i < raw.length; i++) {',
        "    if (raw[i] == '%') {",
        '        out.write(Integer.parseInt(new String(raw, i + 1, 2, java.nio.charset.StandardCharsets.US_ASCII), 16));',
        '        i += 2;',
        '    } else {',
        '        out.write(raw[i]);',
        '    }',
        '}',
        'try {',
        '    return java.nio.charset.StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString();',
        '} catch (java.nio.charset.CharacterCodingException e) {',
        `    throw new IllegalArgumentException("${NOT_UTF8}");`,
        '}'
      ].join('\n'),
      go: [
        'result, err := url.PathUnescape(text)',
        'if err != nil {',
        `\tVgFail("${NOT_URL}")`,
        '}',
        'if !utf8.ValidString(result) {',
        `\tVgFail("${NOT_UTF8}")`,
        '}',
        'return result'
      ].join('\n'),
      lua: [
        'local at = text:find("%", 1, true)',
        'while at do',
        `  if not text:sub(at + 1, at + 2):match("^%x%x$") then error("${NOT_URL}", 0) end`,
        '  at = text:find("%", at + 3, true)',
        'end',
        'local result = text:gsub("%%(%x%x)", function(digits) return string.char(tonumber(digits, 16)) end)',
        `if not utf8.len(result) then error("${NOT_UTF8}", 0) end`,
        'return result'
      ].join('\n'),
      gdscript: [
        'if RegEx.create_from_string("%(?![0-9A-Fa-f]{2})").search(text) != null:',
        `\treturn vg.fail("${NOT_URL}")`,
        'var raw := text.to_utf8_buffer()',
        'var bytes := PackedByteArray()',
        'var i := 0',
        'while i < raw.size():',
        '\tif raw[i] == 37:',
        '\t\tbytes.append((char(raw[i + 1]) + char(raw[i + 2])).hex_to_int())',
        '\t\ti += 3',
        '\telse:',
        '\t\tbytes.append(raw[i])',
        '\t\ti += 1',
        'var result := bytes.get_string_from_utf8()',
        'if result.to_utf8_buffer() != bytes:',
        `\treturn vg.fail("${NOT_UTF8}")`,
        'return result'
      ].join('\n'),
      ruby: [
        `raise ArgumentError, "${NOT_URL}" if text.match?(/%(?![0-9A-Fa-f]{2})/)`,
        'result = text.b.gsub(/%([0-9A-Fa-f]{2})/) { Regexp.last_match(1).hex.chr }.force_encoding("UTF-8")',
        `raise ArgumentError, "${NOT_UTF8}" unless result.valid_encoding?`,
        'return result'
      ].join('\n'),
      php: [
        "if (preg_match('/%(?![0-9A-Fa-f]{2})/', $text)) {",
        `    throw new \\InvalidArgumentException('${NOT_URL}');`,
        '}',
        '$result = rawurldecode($text);',
        "if (!mb_check_encoding($result, 'UTF-8')) {",
        `    throw new \\InvalidArgumentException('${NOT_UTF8}');`,
        '}',
        'return $result;'
      ].join('\n')
    }
  },
  {
    type: 'core:utilities.new-uuid', displayName: 'New UUID', category: 'Utilities', result: STRING, keywords: ['uuid', 'guid', 'id', 'unique', 'random'],
    inputs: [], description: 'A new random UUID (version 4), in lower case: 0b8f5e2c-3f1a-4c6d-9e7b-2a4c6e8f0a1b. A new one each time it is read.',
    // Where a language has no UUIDs: 32 random hex digits, the 13th the version (4) and the 17th
    // the variant (8, 9, a or b).
    code: {
      javascript: 'return /** @type {any} */ (globalThis).crypto.randomUUID();',
      typescript: 'return (globalThis as any).crypto.randomUUID() as string;',
      python: 'import uuid\nreturn str(uuid.uuid4())',
      csharp: 'return Guid.NewGuid().ToString();',
      cpp: [
        'static std::mt19937_64 engine{std::random_device{}()};',
        'static const char* hex = "0123456789abcdef";',
        'std::string result;',
        'for (int i = 0; i < 32; i++) {',
        "    if (i == 8 || i == 12 || i == 16 || i == 20) result += '-';",
        '    int digit = static_cast<int>(engine() % 16);',
        '    result += hex[i == 12 ? 4 : i == 16 ? 8 + digit % 4 : digit];',
        '}',
        'return result;'
      ].join('\n'),
      rust: [
        'let hex = b"0123456789abcdef";',
        'let mut result = String::new();',
        'for i in 0..32 {',
        "    if i == 8 || i == 12 || i == 16 || i == 20 { result.push('-'); }",
        '    let digit = (vgraph::random() * 16.0) as usize;',
        '    result.push(hex[if i == 12 { 4 } else if i == 16 { 8 + digit % 4 } else { digit }] as char);',
        '}',
        'return result;'
      ].join('\n'),
      java: 'return java.util.UUID.randomUUID().toString();',
      go: [
        'const hex = "0123456789abcdef"',
        'result := make([]byte, 0, 36)',
        'for i := 0; i < 32; i++ {',
        '\tif i == 8 || i == 12 || i == 16 || i == 20 {',
        "\t\tresult = append(result, '-')",
        '\t}',
        '\tdigit := rand.Intn(16)',
        '\tif i == 12 {',
        '\t\tdigit = 4',
        '\t} else if i == 16 {',
        '\t\tdigit = 8 + digit%4',
        '\t}',
        '\tresult = append(result, hex[digit])',
        '}',
        'return string(result)'
      ].join('\n'),
      lua: [
        'local hex = "0123456789abcdef"',
        'local out = {}',
        'for i = 0, 31 do',
        '  if i == 8 or i == 12 or i == 16 or i == 20 then out[#out + 1] = "-" end',
        '  local digit = math.random(0, 15)',
        '  if i == 12 then digit = 4 elseif i == 16 then digit = 8 + digit % 4 end',
        '  out[#out + 1] = hex:sub(digit + 1, digit + 1)',
        'end',
        'return table.concat(out)'
      ].join('\n'),
      gdscript: [
        'var hex := "0123456789abcdef"',
        'var result := ""',
        'for i in 32:',
        '\tif i == 8 or i == 12 or i == 16 or i == 20:',
        '\t\tresult += "-"',
        '\tvar digit := randi_range(0, 15)',
        '\tif i == 12:',
        '\t\tdigit = 4',
        '\telif i == 16:',
        '\t\tdigit = 8 + digit % 4',
        '\tresult += hex[digit]',
        'return result'
      ].join('\n'),
      ruby: [
        'digits = Array.new(32) { rand(16) }',
        'digits[12] = 4',
        'digits[16] = 8 + digits[16] % 4',
        'hex = digits.map { |digit| digit.to_s(16) }.join',
        'return "#{hex[0, 8]}-#{hex[8, 4]}-#{hex[12, 4]}-#{hex[16, 4]}-#{hex[20, 12]}"'
      ].join('\n'),
      php: [
        '$bytes = random_bytes(16);',
        '$bytes[6] = chr(ord($bytes[6]) & 0x0F | 0x40);',
        '$bytes[8] = chr(ord($bytes[8]) & 0x3F | 0x80);',
        "return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));"
      ].join('\n')
    }
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
