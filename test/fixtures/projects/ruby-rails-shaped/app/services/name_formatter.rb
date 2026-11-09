# frozen_string_literal: true

# Formats names for display.
module NameFormatter
  # Capitalizes a name's first letter.
  # @blueprint pure
  # @param [String] name
  # @return [String]
  def self.title(name)
    name.capitalize
  end
end
