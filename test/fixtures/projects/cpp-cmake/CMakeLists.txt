cmake_minimum_required(VERSION 3.20)
project(corpus CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_subdirectory(lib)

add_executable(corpus src/main.cpp)
target_link_libraries(corpus PRIVATE corpus_text)
target_compile_options(corpus PRIVATE -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Werror)
