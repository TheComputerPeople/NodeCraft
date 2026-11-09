extends SceneTree
## Loads every script of the project (not its addons, which Godot doesn't warn about), so each one
## parses with the project's warnings as errors; quits with 1 when any doesn't.


func _initialize() -> void:
	var failed := _check("res://")
	print("%d script(s) failed to load." % failed if failed else "Every script loads.")
	quit(1 if failed else 0)


func _check(folder: String) -> int:
	var failed := 0
	for name in DirAccess.get_files_at(folder):
		if not name.ends_with(".gd"):
			continue
		# A script that doesn't compile still loads, but can't make objects.
		var script := load(folder.path_join(name)) as Script
		if script == null or not script.can_instantiate():
			print("Doesn't compile: %s" % folder.path_join(name))
			failed += 1
	for name in DirAccess.get_directories_at(folder):
		if not name.begins_with(".") and name != "addons":
			failed += _check(folder.path_join(name))
	return failed
