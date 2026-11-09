add_library(corpus_text src/text.cpp)
target_include_directories(corpus_text PUBLIC include)
target_compile_options(corpus_text PRIVATE -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Werror)
