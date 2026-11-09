class_name BigCounter
extends Counter
## Counts in tens.


## @blueprint
func _init(start: float) -> void:
	super(start * 10)
