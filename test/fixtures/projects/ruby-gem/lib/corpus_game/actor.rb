# frozen_string_literal: true

module CorpusGame
  # Someone in the game, whom graph classes extend.
  # @blueprint
  class Actor
    # @blueprint
    # @return [Integer]
    attr_accessor :health

    # @blueprint
    # @param name [String]
    def initialize(name)
      @name = name
      @health = 100
    end

    # @blueprint
    # @return [String]
    def greet
      "#{@name} has #{@health}"
    end

    # @blueprint overridable
    # @param damage [Integer]
    def hit(damage)
      @health -= damage
      puts "#{@name} takes #{damage}"
    end

    # @blueprint overridable
    # @return [String]
    def describe
      'someone'
    end

    # @blueprint
    def turn
      puts "#{@name} is #{describe}"
      hit(3)
      puts greet
    end
  end
end
