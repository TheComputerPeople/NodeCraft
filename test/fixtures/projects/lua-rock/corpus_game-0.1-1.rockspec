package = "corpus_game"
version = "0.1-1"
source = { url = "git+https://example.com/corpus_game.git" }
description = { summary = "The corpus's rock: graphs that call its code and that its code calls.", license = "MIT" }
dependencies = { "lua >= 5.4" }
build = {
  type = "builtin",
  modules = {
    ["corpus_game.text"] = "src/corpus_game/text.lua",
    ["corpus_game.features"] = "src/corpus_game/features.lua",
  },
}
