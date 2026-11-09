class_name Counter
extends RefCounted
## Counts.

## @blueprint
var count: float = 0


## @blueprint
func _init(start: float) -> void:
	count = start


## @blueprint
func add(amount: float) -> float:
	count += amount
	return count


## @blueprint pure
func doubled() -> float:
	return count * 2
