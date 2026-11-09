# frozen_string_literal: true

# Loads the app as Rails would autoload it: services, then graphs.
module CorpusApp
  ROOT = File.expand_path('..', __dir__)

  def self.load!
    %w[app/services app/graphs].each do |folder|
      Dir[File.join(ROOT, folder, '*.rb')].each { |file| require file }
    end
  end
end

CorpusApp.load!
