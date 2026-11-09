cmake_minimum_required(VERSION 3.20)
project(corpus C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(corpus src/main.cpp src/measure.c)
target_compile_options(corpus PRIVATE -Wall -Wextra -Wpedantic -Werror)
