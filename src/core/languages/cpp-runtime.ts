// The support code every generated C++ header carries (docs/language-breadth.md, "C++"): value
// formatting by docs/semantics.md, an insertion-ordered map, event dispatchers, the latent queue and
// object references. It's inline code behind one include guard, so a program that includes several
// generated headers has it once, and generated files stay self-contained.
export const CPP_RUNTIME_GUARD = 'VGRAPH_RUNTIME_1';

export const CPP_RUNTIME_INCLUDES = [
  '<algorithm>', '<any>', '<cctype>', '<charconv>', '<chrono>', '<cmath>', '<cstdint>', '<cstdio>', '<fstream>', '<functional>', '<iostream>',
  '<memory>', '<random>', '<regex>', '<set>', '<sstream>', '<stdexcept>', '<string>', '<thread>', '<tuple>', '<typeindex>', '<typeinfo>', '<utility>', '<vector>'
];

export const CPP_RUNTIME = String.raw`namespace vgraph {

// Every generated class derives from Object, so Self can be a shared reference to it.
class Object : public std::enable_shared_from_this<Object> {
public:
    virtual ~Object() = default;
};

// An object member is reached through its object, which isn't None (else the run stops, as Unreal
// stops on "Accessed None").
template <class T> T& deref(const std::shared_ptr<T>& object) {
    if (!object) throw std::runtime_error("Accessed None");
    return *object;
}

// An object of a class from the project's code (docs/node-authoring.md, gap 2), in a std::any: the
// object as its own class and as each class it extends, so a member of any of them finds it.
struct CodeObject {
    std::vector<std::pair<std::type_index, std::shared_ptr<void>>> as;
};

template <class T, class... Bases, class... Args> std::any code_new(Args&&... args) {
    auto object = std::make_shared<T>(std::forward<Args>(args)...);
    CodeObject held;
    held.as.emplace_back(typeid(T), object);
    (held.as.emplace_back(typeid(Bases), std::static_pointer_cast<Bases>(object)), ...);
    return held;
}

// The object as class T (else the run stops, as Unreal stops on "Accessed None").
template <class T> T& code_object(const std::any& value) {
    if (auto held = std::any_cast<CodeObject>(&value)) {
        for (const auto& [type, object] : held->as) {
            if (type == typeid(T)) return *std::static_pointer_cast<T>(object);
        }
    }
    throw std::runtime_error("Accessed None");
}

inline bool is_valid(const std::any& value) {
    return value.has_value();
}
template <class T> bool is_valid(const std::shared_ptr<T>& object) {
    return object != nullptr;
}

// A map that keeps its keys in the order they were added, as every other target's maps do.
template <class K, class V> class Map {
public:
    using key_type = K;
    using mapped_type = V;
    Map() = default;
    Map(std::initializer_list<std::pair<K, V>> items) {
        for (const auto& item : items) (*this)[item.first] = item.second;
    }
    V& operator[](const K& key) {
        for (auto& entry : entries) if (entry.first == key) return entry.second;
        entries.emplace_back(key, V{});
        return entries.back().second;
    }
    const V& at(const K& key) const {
        for (const auto& entry : entries) if (entry.first == key) return entry.second;
        throw std::runtime_error("Key not found");
    }
    bool contains(const K& key) const {
        for (const auto& entry : entries) if (entry.first == key) return true;
        return false;
    }
    bool erase(const K& key) {
        for (auto it = entries.begin(); it != entries.end(); ++it) {
            if (it->first == key) {
                entries.erase(it);
                return true;
            }
        }
        return false;
    }
    std::size_t size() const { return entries.size(); }
    void clear() { entries.clear(); }
    auto begin() { return entries.begin(); }
    auto end() { return entries.end(); }
    auto begin() const { return entries.begin(); }
    auto end() const { return entries.end(); }
    bool operator==(const Map&) const = default;
    std::vector<std::pair<K, V>> entries;
};

// Unreal's event dispatcher: bound events (an object's event, bound once) run in the order they
// were bound.
template <class... Args> class Dispatcher {
public:
    void bind(const void* owner, const std::string& event, std::function<void(Args...)> run) {
        for (const auto& binding : bindings) if (binding.owner == owner && binding.event == event) return;
        bindings.push_back({owner, event, std::move(run)});
    }
    void unbind(const void* owner, const std::string& event) {
        std::erase_if(bindings, [&](const Binding& b) { return b.owner == owner && b.event == event; });
    }
    void clear() { bindings.clear(); }
    // A copy, so events that bind or unbind while running don't disturb the loop.
    void broadcast(Args... args) {
        auto running = bindings;
        for (auto& binding : running) binding.run(args...);
    }
private:
    struct Binding {
        const void* owner;
        std::string event;
        std::function<void(Args...)> run;
    };
    std::vector<Binding> bindings;
};

// Latent actions of every class run from one queue, in the order they fall due, once start() has
// returned: run_latent_actions() runs them.
struct LatentAction {
    double due;
    long long order;
    std::function<void()> run;
};
inline std::vector<LatentAction>& latent_queue() {
    static std::vector<LatentAction> queue;
    return queue;
}
inline double latent_clock() {
    static const auto start = std::chrono::steady_clock::now();
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
}
inline void delay(double seconds, std::function<void()> then) {
    static long long order = 0;
    latent_queue().push_back({latent_clock() + std::max(0.0, seconds), order++, std::move(then)});
}
inline void run_latent_actions() {
    auto& queue = latent_queue();
    while (!queue.empty()) {
        auto next = std::min_element(queue.begin(), queue.end(), [](const LatentAction& a, const LatentAction& b) {
            return a.due < b.due || (a.due == b.due && a.order < b.order);
        });
        LatentAction action = *next;
        queue.erase(next);
        double wait = action.due - latent_clock();
        if (wait > 0) std::this_thread::sleep_for(std::chrono::duration<double>(wait));
        action.run();
    }
}

// JavaScript's number-to-text rules, so every target language prints numbers the same way.
inline std::string format_number(double x) {
    if (std::isnan(x)) return "NaN";
    if (std::isinf(x)) return x > 0 ? "Infinity" : "-Infinity";
    if (x == 0) return "0";
    std::string sign = x < 0 ? "-" : "";
    char buffer[64];
    auto end = std::to_chars(buffer, buffer + sizeof buffer, std::fabs(x), std::chars_format::scientific).ptr;
    std::string text(buffer, end);
    auto e = text.find('e');
    int exponent = std::stoi(text.substr(e + 1));
    std::string digits;
    for (char c : text.substr(0, e)) if (c != '.') digits += c;
    while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
    int k = static_cast<int>(digits.size());
    int n = exponent + 1;
    if (k <= n && n <= 21) return sign + digits + std::string(n - k, '0');
    if (0 < n && n <= 21) return sign + digits.substr(0, n) + "." + digits.substr(n);
    if (-6 < n && n <= 0) return sign + "0." + std::string(-n, '0') + digits;
    std::string rest = k > 1 ? "." + digits.substr(1) : "";
    return sign + digits.substr(0, 1) + rest + "e" + (n - 1 >= 0 ? "+" : "-") + std::to_string(std::abs(n - 1));
}

inline std::string json_string(const std::string& text) {
    std::string json = "\"";
    for (unsigned char c : text) {
        switch (c) {
            case '"': json += "\\\""; break;
            case '\\': json += "\\\\"; break;
            case '\n': json += "\\n"; break;
            case '\r': json += "\\r"; break;
            case '\t': json += "\\t"; break;
            case '\b': json += "\\b"; break;
            case '\f': json += "\\f"; break;
            default:
                if (c < 0x20) {
                    char escape[8];
                    std::snprintf(escape, sizeof escape, "\\u%04x", c);
                    json += escape;
                } else {
                    json += static_cast<char>(c);
                }
        }
    }
    return json + "\"";
}

inline double to_number(double value) { return value; }
inline double to_number(long long value) { return static_cast<double>(value); }
inline double to_number(int value) { return value; }
inline double to_number(bool value) { return value ? 1 : 0; }
inline double to_number(const std::string& value) {
    auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return 0;
    auto last = value.find_last_not_of(" \t\r\n");
    std::string trimmed = value.substr(first, last - first + 1);
    char* end = nullptr;
    double parsed = std::strtod(trimmed.c_str(), &end);
    return end == trimmed.c_str() + trimmed.size() ? parsed : NAN;
}
inline double to_number(const std::any& value) {
    if (!value.has_value()) return 0;
    if (auto v = std::any_cast<double>(&value)) return *v;
    if (auto v = std::any_cast<long long>(&value)) return static_cast<double>(*v);
    if (auto v = std::any_cast<int>(&value)) return *v;
    if (auto v = std::any_cast<bool>(&value)) return *v ? 1 : 0;
    if (auto v = std::any_cast<std::string>(&value)) return to_number(*v);
    return NAN;
}

inline bool to_boolean(bool value) { return value; }
inline bool to_boolean(double value) { return value != 0 && !std::isnan(value); }
inline bool to_boolean(long long value) { return value != 0; }
inline bool to_boolean(int value) { return value != 0; }
inline bool to_boolean(const std::string& value) { return !value.empty(); }
inline bool to_boolean(const std::any& value) {
    if (!value.has_value()) return false;
    if (auto v = std::any_cast<bool>(&value)) return *v;
    if (auto v = std::any_cast<double>(&value)) return to_boolean(*v);
    if (auto v = std::any_cast<long long>(&value)) return *v != 0;
    if (auto v = std::any_cast<int>(&value)) return *v != 0;
    if (auto v = std::any_cast<std::string>(&value)) return !v->empty();
    return true;
}
template <class T> bool to_boolean(const std::shared_ptr<T>& value) { return value != nullptr; }

// A value of unknown type, used where a typed one is needed.
template <class T> T as(const std::any& value) {
    if (!value.has_value()) return T{};
    if (auto v = std::any_cast<T>(&value)) return *v;
    if constexpr (std::is_arithmetic_v<T>) return static_cast<T>(to_number(value));
    else if constexpr (std::is_same_v<T, std::string>) return "";
    else throw std::runtime_error("Wrong type");
}
template <class T, class U> T as(const U& value) {
    if constexpr (std::is_convertible_v<U, T>) return static_cast<T>(value);
    else return T{};
}

}  // namespace vgraph

// Values as JSON (containers and structs print this way) and as text (docs/semantics.md, "Values").
// They live in the global namespace, next to the structs and enums generated code declares, so
// overloads for those are found wherever a container holds them.
inline std::string vgraph_json(double value) { return std::isfinite(value) ? vgraph::format_number(value) : "null"; }
inline std::string vgraph_json(long long value) { return vgraph::format_number(static_cast<double>(value)); }
inline std::string vgraph_json(int value) { return vgraph::format_number(value); }
inline std::string vgraph_json(bool value) { return value ? "true" : "false"; }
inline std::string vgraph_json(const std::string& value) { return vgraph::json_string(value); }
inline std::string vgraph_json(const std::any& value);
inline std::string vgraph_format(const std::string& value) { return value; }
inline std::string vgraph_format(double value) { return vgraph::format_number(value); }
inline std::string vgraph_format(long long value) { return vgraph::format_number(static_cast<double>(value)); }
inline std::string vgraph_format(int value) { return vgraph::format_number(value); }
inline std::string vgraph_format(bool value) { return value ? "true" : "false"; }
template <class T> std::string vgraph_json(const std::vector<T>& items) {
    std::string json = "[";
    for (std::size_t i = 0; i < items.size(); i++) json += (i ? "," : "") + vgraph_json(items[i]);
    return json + "]";
}
// Sets in ascending order (they have no order of their own).
template <class T> std::string vgraph_json(const std::set<T>& items) {
    std::string json = "[";
    bool first = true;
    for (const auto& item : items) {
        json += (first ? "" : ",") + vgraph_json(item);
        first = false;
    }
    return json + "]";
}
template <class K, class V> std::string vgraph_json(const vgraph::Map<K, V>& map) {
    std::string json = "{";
    bool first = true;
    for (const auto& [key, value] : map) {
        std::string name;
        if constexpr (std::is_same_v<K, std::string>) name = key;
        else name = vgraph_format(key);
        json += (first ? "" : ",") + vgraph::json_string(name) + ":" + vgraph_json(value);
        first = false;
    }
    return json + "}";
}
template <class T> std::string vgraph_format(const std::vector<T>& value) { return vgraph_json(value); }
template <class T> std::string vgraph_format(const std::set<T>& value) { return vgraph_json(value); }
template <class K, class V> std::string vgraph_format(const vgraph::Map<K, V>& value) { return vgraph_json(value); }
inline std::string vgraph_format(const std::any& value) {
    if (!value.has_value()) return "";
    if (auto v = std::any_cast<std::string>(&value)) return *v;
    if (auto v = std::any_cast<double>(&value)) return vgraph::format_number(*v);
    if (auto v = std::any_cast<long long>(&value)) return vgraph::format_number(static_cast<double>(*v));
    if (auto v = std::any_cast<int>(&value)) return vgraph::format_number(*v);
    if (auto v = std::any_cast<bool>(&value)) return *v ? "true" : "false";
    return "";
}
inline std::string vgraph_json(const std::any& value) {
    if (!value.has_value()) return "null";
    if (auto v = std::any_cast<std::string>(&value)) return vgraph::json_string(*v);
    return vgraph_format(value);
}`;
