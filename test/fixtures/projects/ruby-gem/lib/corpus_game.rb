# frozen_string_literal: true

require_relative 'corpus_game/text'
require_relative 'corpus_game/features'
require_relative 'corpus_game/graphs/greeting_vgraph'
require_relative 'corpus_game/graphs/counting_vgraph'
require_relative 'corpus_game/graphs/dividing_vgraph'
require_relative 'corpus_game/graphs/fetching_vgraph'

# The corpus's gem: its graphs greet and use its features.
module CorpusGame
  # Greets Ada through the Greeting graph.
  def self.greeting
    Greeting.greet('ada')
  end

  # Runs the graphs that use the gem's features, then their Delays and threads.
  def self.run_features
    Counting.new.start
    Dividing.new.start
    Fetching.new.start
    Vg.run_latent_actions
  end
end
