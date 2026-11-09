-- Greets Ada, then runs the graphs that use the rock's features.
package.path = "src/?.lua;src/?/init.lua;" .. package.path

local greeting = require("corpus_game.graphs.greeting_vgraph")
local Counting = require("corpus_game.graphs.counting_vgraph")
local Dividing = require("corpus_game.graphs.dividing_vgraph")
local Fetching = require("corpus_game.graphs.fetching_vgraph")
local vg = require("vgraph_runtime")

print(greeting.greet("ada"))
Counting.new():start()
Dividing.new():start()
Fetching.new():start()
-- Delays and coroutines the graphs wait on.
vg.run_latent_actions()
