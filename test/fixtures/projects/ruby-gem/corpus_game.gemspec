# frozen_string_literal: true

Gem::Specification.new do |spec|
  spec.name = 'corpus_game'
  spec.version = '0.1.0'
  spec.authors = ['NodeCraft']
  spec.summary = 'The corpus gem: graphs that call its code and that its code calls.'
  spec.license = 'MIT'
  spec.required_ruby_version = '>= 3.3'
  spec.files = Dir['lib/**/*.rb', 'exe/*']
  spec.bindir = 'exe'
  spec.executables = ['corpus_game']
  spec.require_paths = ['lib']
  spec.metadata['rubygems_mfa_required'] = 'true'
end
