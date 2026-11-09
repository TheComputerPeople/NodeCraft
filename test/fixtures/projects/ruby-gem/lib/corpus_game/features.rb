# frozen_string_literal: true

module CorpusGame
  # Counts.
  class Counter
    # @blueprint
    # @return [Float]
    attr_accessor :count

    # @blueprint
    # @param [Float] start
    def initialize(start)
      @count = start
    end

    # @blueprint
    # @param [Float] amount
    # @return [Float]
    def add(amount)
      @count += amount
    end

    # @blueprint pure
    # @return [Float]
    def doubled
      @count * 2
    end
  end

  # Counts in tens.
  class BigCounter < Counter
    # @blueprint
    # @param [Float] start
    def initialize(start)
      super(start * 10)
    end
  end

  # Division.
  module Arithmetic
    # @blueprint
    # @param [Integer] a
    # @param [Integer] b
    # @return [Array(Integer, Integer)]
    # @outputs quotient remainder
    def self.divide(a, b)
      [a / b, a % b]
    end
  end

  # Fetching, later.
  module Remote
    # @blueprint
    # @param [Integer] value
    # @return [Thread<Integer>]
    def self.fetch_double(value)
      Thread.new do
        sleep(0.01)
        value * 2
      end
    end
  end
end
