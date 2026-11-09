--- What the graphs use beyond plain functions.
local M = {}

---@class Counter
---@field count number @blueprint
local Counter = {}
Counter.__index = Counter

---@blueprint
---@param start number
---@return Counter
function Counter.new(start)
  return setmetatable({ count = start }, Counter)
end

---@blueprint
---@param amount number
---@return number
function Counter:add(amount)
  self.count = self.count + amount
  return self.count
end

---@blueprint pure
---@return number
function Counter:doubled()
  return self.count * 2
end

---@class BigCounter
local BigCounter = {}
BigCounter.__index = BigCounter

---@blueprint
---@param start number
function BigCounter.new(start)
  return setmetatable({ count = start * 10 }, BigCounter)
end

---@blueprint
---@param amount number
---@return number
function BigCounter:add(amount)
  self.count = self.count + amount
  return self.count
end

M.Counter = Counter
M.BigCounter = BigCounter

---@blueprint
---@param a integer
---@param b integer
---@return integer quotient
---@return integer remainder
function M.divide(a, b)
  return a // b, a % b
end

---@blueprint
---@async
---@param value integer
---@return integer
function M.fetch_double(value)
  local ready = os.clock() + 0.01
  while os.clock() < ready do coroutine.yield() end
  return value * 2
end

return M
