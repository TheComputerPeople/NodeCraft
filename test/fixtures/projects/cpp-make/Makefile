# The corpus's Makefile project: every source of src/ and src/graphs/, warnings as errors.
ifeq ($(origin CXX),default)
CXX := g++
endif
CXXFLAGS := -std=c++20 -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Werror -Isrc
SOURCES := $(wildcard src/*.cpp) $(wildcard src/graphs/*.cpp)

corpus: $(SOURCES)
	$(CXX) $(CXXFLAGS) -o $@ $(SOURCES)
