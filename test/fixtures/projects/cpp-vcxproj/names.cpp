#include "names.h"

#include <cctype>

namespace names {

std::string title(const std::string& name) {
    std::string result = name;
    if (!result.empty()) result[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(result[0])));
    return result;
}

}  // namespace names
