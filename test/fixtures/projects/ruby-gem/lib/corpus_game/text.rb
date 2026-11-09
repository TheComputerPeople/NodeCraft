# frozen_string_literal: true

module CorpusGame
  # Formatting names.
  module Text
    # Capitalizes a name's first letter.
    # @blueprint pure
    # @param [String] name
    # @return [String]
    def self.title(name)
      name.capitalize
    end
  end
end
