extends RefCounted
## Fetching, later.


## Twice value, after two frames.
## @blueprint
static func fetch_double(value: int) -> int:
	var tree := Engine.get_main_loop() as SceneTree
	await tree.process_frame
	await tree.process_frame
	return value * 2
