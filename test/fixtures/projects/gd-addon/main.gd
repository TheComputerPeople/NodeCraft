extends Node
## Greets Ada, then runs the graphs that use the addon's code, and quits.

const Greeting = preload("res://scenes/graphs/greeting_vgraph.gd")
const Counting = preload("res://scenes/graphs/counting_vgraph.gd")
const Questing = preload("res://scenes/graphs/questing_vgraph.gd")
const Fetching = preload("res://scenes/graphs/fetching_vgraph.gd")
const vg = preload("res://scenes/graphs/vgraph_runtime.gd")


func _ready() -> void:
	print(Greeting.greet("ada"))
	Counting.new().start()
	Questing.new().start()
	Fetching.new().start()
	# Delays and coroutines the graphs wait on, while the tree runs frames.
	await vg.run_latent_actions(get_tree())
	get_tree().quit(1 if vg.failed() else 0)
