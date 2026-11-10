// One function per language for the control flow's golden flowcharts (test/unit/code-flow.test.ts):
// each has a branch, a loop with a break, a try/catch where the language has one (an error return
// where it doesn't), and an early return. `line` is a line inside the function.
import { GrammarId } from '../../src/core/parsing/grammars';

export const FLOW_CASES: { grammar: GrammarId; line: number; code: string }[] = [
  {
    grammar: 'typescript', line: 2, code: `export async function total(items: Item[]): Promise<number> {
  if (!items.length) return 0;
  let sum = 0;
  for (const item of items) {
    if (item.price < 0) break;
    sum += item.price;
  }
  try {
    await save(sum);
  } catch (error) {
    console.error(error);
    throw error;
  }
  return sum;
}
` },
  {
    grammar: 'javascript', line: 2, code: `function total(items) {
  if (!items.length) return 0;
  let sum = 0;
  for (const item of items) {
    if (item.price < 0) break;
    sum += item.price;
  }
  try {
    save(sum);
  } catch (error) {
    throw error;
  }
  return sum;
}
` },
  {
    grammar: 'python', line: 2, code: `def total(items):
    if not items:
        return 0
    total = 0
    for item in items:
        if item.price < 0:
            break
        total += item.price
    try:
        save(total)
    except IOError as error:
        log(error)
        raise
    return total
` },
  {
    grammar: 'c_sharp', line: 3, code: `class Cart {
  public int Total(List<Item> items) {
    if (items.Count == 0) return 0;
    var sum = 0;
    foreach (var item in items) {
      if (item.Price < 0) break;
      sum += item.Price;
    }
    try {
      Save(sum);
    } catch (IOException error) {
      Log(error);
      throw;
    }
    return sum;
  }
}
` },
  {
    grammar: 'c', line: 2, code: `int total(const int *prices, int n) {
  if (n == 0) return 0;
  int sum = 0;
  for (int i = 0; i < n; i++) {
    if (prices[i] < 0) break;
    sum += prices[i];
  }
  if (save(sum) != 0) {
    return -1;
  }
  return sum;
}
` },
  {
    grammar: 'cpp', line: 2, code: `int total(const std::vector<Item>& items) {
  if (items.empty()) return 0;
  int sum = 0;
  for (const auto& item : items) {
    if (item.price < 0) break;
    sum += item.price;
  }
  try {
    save(sum);
  } catch (const std::exception& error) {
    log(error);
    throw;
  }
  return sum;
}
` },
  {
    grammar: 'rust', line: 2, code: `fn total(items: &[Item]) -> Result<i32, Error> {
    if items.is_empty() {
        return Ok(0);
    }
    let mut sum = 0;
    for item in items {
        if item.price < 0 {
            break;
        }
        sum += item.price;
    }
    match save(sum) {
        Ok(()) => Ok(sum),
        Err(error) => Err(error),
    }
}
` },
  {
    grammar: 'java', line: 3, code: `class Cart {
  int total(List<Item> items) {
    if (items.isEmpty()) return 0;
    int sum = 0;
    for (Item item : items) {
      if (item.price < 0) break;
      sum += item.price;
    }
    try {
      save(sum);
    } catch (IOException error) {
      log(error);
      throw new RuntimeException(error);
    }
    return sum;
  }
}
` },
  {
    grammar: 'go', line: 3, code: `package cart

func Total(items []Item) (int, error) {
	if len(items) == 0 {
		return 0, nil
	}
	sum := 0
	for _, item := range items {
		if item.Price < 0 {
			break
		}
		sum += item.Price
	}
	if err := save(sum); err != nil {
		return 0, err
	}
	return sum, nil
}
` },
  {
    grammar: 'lua', line: 2, code: `local function total(items)
  if #items == 0 then return 0 end
  local sum = 0
  for _, item in ipairs(items) do
    if item.price < 0 then break end
    sum = sum + item.price
  end
  local ok, err = pcall(save, sum)
  if not ok then
    error(err)
  end
  return sum
end
` },
  {
    grammar: 'gdscript', line: 2, code: `func total(items: Array) -> int:
	if items.is_empty():
		return 0
	var sum := 0
	for item in items:
		if item.price < 0:
			break
		sum += item.price
	var error := save(sum)
	if error != OK:
		push_error("save failed")
		return -1
	return sum
` },
  {
    grammar: 'ruby', line: 2, code: `def total(items)
  return 0 if items.empty?
  sum = 0
  for item in items
    break if item.price < 0
    sum += item.price
  end
  begin
    save(sum)
  rescue IOError => error
    log(error)
    raise
  end
  sum
end
` },
  {
    grammar: 'php', line: 3, code: `<?php
function total(array $items): int {
  if (count($items) === 0) return 0;
  $sum = 0;
  foreach ($items as $item) {
    if ($item->price < 0) break;
    $sum += $item->price;
  }
  try {
    save($sum);
  } catch (IOException $error) {
    log_error($error);
    throw $error;
  }
  return $sum;
}
` }
];
