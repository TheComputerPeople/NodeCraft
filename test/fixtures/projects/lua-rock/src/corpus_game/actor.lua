--- Someone in the game, whom graph classes extend.
---@class Actor
---@field health integer Its health. @blueprint
local Actor = {}
Actor.__index = Actor

---@blueprint
---@param name string
function Actor.new(name)
  local self = setmetatable({}, Actor)
  self.name = name
  self.health = 100
  return self
end

---@blueprint
---@return string
function Actor:greet()
  return self.name .. " has " .. self.health
end

---@blueprint overridable
---@param damage integer
function Actor:hit(damage)
  self.health = self.health - damage
  print(self.name .. " takes " .. damage)
end

---@blueprint overridable
---@return string
function Actor:describe()
  return "someone"
end

---@blueprint
function Actor:turn()
  print(self.name .. " is " .. self:describe())
  self:hit(3)
  print(self:greet())
end

return Actor
