class_name Actor
extends RefCounted
## Someone in the game, whom graph classes extend.
## @blueprint

## @blueprint
var health: int = 100

var _name: String


## @blueprint
func _init(name: String) -> void:
	_name = name


## @blueprint
func greet() -> String:
	return "%s has %d" % [_name, health]


## @blueprint overridable
func hit(damage: int) -> void:
	health -= damage
	print("%s takes %d" % [_name, damage])


## @blueprint overridable
func describe() -> String:
	return "someone"


## @blueprint
func turn() -> void:
	print("%s is %s" % [_name, describe()])
	hit(3)
	print(greet())
