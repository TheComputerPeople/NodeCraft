-- Greets the name it's given through the Greeting graph: lua main.lua ada
local greeting = require("greeting_vgraph")

print(greeting.greet(arg[1] or "world"))
