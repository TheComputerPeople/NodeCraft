--- Formatting names.
local M = {}

--- Capitalizes a name's first letter.
---@blueprint pure
---@param name string
---@return string
function M.title(name)
  return (name:gsub("^%l", string.upper))
end

return M
