// The golden flowcharts of test/unit/code-flow-cases.ts: each arrow "from -label-> to", by the boxes' first lines
// ("^" marks an arrow back up). Checked by hand when written.
export const GOLDEN: Record<string, { name: string; lines: [number, number]; arrows: string[] }> = {
  "typescript": {
    name: "total", lines: [1,15],
    arrows: [
      "total --> (!items.length)",
      "(!items.length) -true-> return 0;",
      "(!items.length) -false-> let sum = 0;",
      "let sum = 0; --> for (const item of items)",
      "for (const item of items) -loop-> (item.price < 0)",
      "(item.price < 0) -true-> break;",
      "(item.price < 0) -false-> sum += item.price;",
      "sum += item.price; -^-> for (const item of items)",
      "break; --> await save(sum);",
      "for (const item of items) -done-> await save(sum);",
      "await save(sum); -exception-> catch (error)",
      "catch (error) --> console.error(error);",
      "console.error(error); --> throw error;",
      "await save(sum); --> return sum;",
      "return 0; --> End",
      "return sum; --> End",
      "throw error; -throws-> End"
    ]
  },
  "javascript": {
    name: "total", lines: [1,14],
    arrows: [
      "total --> (!items.length)",
      "(!items.length) -true-> return 0;",
      "(!items.length) -false-> let sum = 0;",
      "let sum = 0; --> for (const item of items)",
      "for (const item of items) -loop-> (item.price < 0)",
      "(item.price < 0) -true-> break;",
      "(item.price < 0) -false-> sum += item.price;",
      "sum += item.price; -^-> for (const item of items)",
      "break; --> save(sum);",
      "for (const item of items) -done-> save(sum);",
      "save(sum); -exception-> catch (error)",
      "catch (error) --> throw error;",
      "save(sum); --> return sum;",
      "return 0; --> End",
      "return sum; --> End",
      "throw error; -throws-> End"
    ]
  },
  "python": {
    name: "total", lines: [1,14],
    arrows: [
      "total --> not items",
      "not items -true-> return 0",
      "not items -false-> total = 0",
      "total = 0 --> for item in items:",
      "for item in items: -loop-> item.price < 0",
      "item.price < 0 -true-> break",
      "item.price < 0 -false-> total += item.price",
      "total += item.price -^-> for item in items:",
      "break --> save(total)",
      "for item in items: -done-> save(total)",
      "save(total) -exception-> except IOError as error",
      "except IOError as error --> log(error)",
      "log(error) --> raise",
      "save(total) --> return total",
      "return 0 --> End",
      "return total --> End",
      "raise -throws-> End"
    ]
  },
  "c_sharp": {
    name: "Total", lines: [2,16],
    arrows: [
      "Total --> items.Count == 0",
      "items.Count == 0 -true-> return 0;",
      "items.Count == 0 -false-> var sum = 0;",
      "var sum = 0; --> foreach (var item in items)",
      "foreach (var item in items) -loop-> item.Price < 0",
      "item.Price < 0 -true-> break;",
      "item.Price < 0 -false-> sum += item.Price;",
      "sum += item.Price; -^-> foreach (var item in items)",
      "break; --> Save(sum);",
      "foreach (var item in items) -done-> Save(sum);",
      "Save(sum); -exception-> catch (IOException error)",
      "catch (IOException error) --> Log(error);",
      "Log(error); --> throw;",
      "Save(sum); --> return sum;",
      "return 0; --> End",
      "return sum; --> End",
      "throw; -throws-> End"
    ]
  },
  "c": {
    name: "total", lines: [1,12],
    arrows: [
      "total --> (n == 0)",
      "(n == 0) -true-> return 0;",
      "(n == 0) -false-> int sum = 0;",
      "int sum = 0; --> for (int i = 0; i < n; i++)",
      "for (int i = 0; i < n; i++) -loop-> (prices[i] < 0)",
      "(prices[i] < 0) -true-> break;",
      "(prices[i] < 0) -false-> sum += prices[i];",
      "sum += prices[i]; -^-> for (int i = 0; i < n; i++)",
      "break; --> (save(sum) != 0)",
      "for (int i = 0; i < n; i++) -done-> (save(sum) != 0)",
      "(save(sum) != 0) -true-> return -1;",
      "(save(sum) != 0) -false-> return sum;",
      "return 0; --> End",
      "return -1; --> End",
      "return sum; --> End"
    ]
  },
  "cpp": {
    name: "total", lines: [1,15],
    arrows: [
      "total --> (items.empty())",
      "(items.empty()) -true-> return 0;",
      "(items.empty()) -false-> int sum = 0;",
      "int sum = 0; --> for (const auto& item : items)",
      "for (const auto& item : items) -loop-> (item.price < 0)",
      "(item.price < 0) -true-> break;",
      "(item.price < 0) -false-> sum += item.price;",
      "sum += item.price; -^-> for (const auto& item : items)",
      "break; --> save(sum);",
      "for (const auto& item : items) -done-> save(sum);",
      "save(sum); -exception-> catch (const std::exception& error)",
      "catch (const std::exception& error) --> log(error);",
      "log(error); --> throw;",
      "save(sum); --> return sum;",
      "return 0; --> End",
      "return sum; --> End",
      "throw; -throws-> End"
    ]
  },
  "rust": {
    name: "total", lines: [1,16],
    arrows: [
      "total --> items.is_empty()",
      "items.is_empty() -true-> return Ok(0)",
      "items.is_empty() -false-> let mut sum = 0;",
      "let mut sum = 0; --> for item in items",
      "for item in items -loop-> item.price < 0",
      "item.price < 0 -true-> break",
      "item.price < 0 -false-> sum += item.price;",
      "sum += item.price; -^-> for item in items",
      "break --> match save(sum)",
      "for item in items -done-> match save(sum)",
      "match save(sum) -Ok(())-> Ok(sum)",
      "match save(sum) -Err(error)-> Err(error)",
      "Ok(sum) --> End",
      "Err(error) --> End",
      "return Ok(0) --> End"
    ]
  },
  "java": {
    name: "total", lines: [2,16],
    arrows: [
      "total --> (items.isEmpty())",
      "(items.isEmpty()) -true-> return 0;",
      "(items.isEmpty()) -false-> int sum = 0;",
      "int sum = 0; --> for (Item item : items)",
      "for (Item item : items) -loop-> (item.price < 0)",
      "(item.price < 0) -true-> break;",
      "(item.price < 0) -false-> sum += item.price;",
      "sum += item.price; -^-> for (Item item : items)",
      "break; --> save(sum);",
      "for (Item item : items) -done-> save(sum);",
      "save(sum); -exception-> catch (IOException error)",
      "catch (IOException error) --> log(error);",
      "log(error); --> throw new RuntimeException(error);",
      "save(sum); --> return sum;",
      "return 0; --> End",
      "return sum; --> End",
      "throw new RuntimeException(error); -throws-> End"
    ]
  },
  "go": {
    name: "Total", lines: [3,18],
    arrows: [
      "Total --> len(items) == 0",
      "len(items) == 0 -true-> return 0, nil",
      "len(items) == 0 -false-> sum := 0",
      "sum := 0 --> for _, item := range items",
      "for _, item := range items -loop-> item.Price < 0",
      "item.Price < 0 -true-> break",
      "item.Price < 0 -false-> sum += item.Price",
      "sum += item.Price -^-> for _, item := range items",
      "break --> err := save(sum)",
      "for _, item := range items -done-> err := save(sum)",
      "err := save(sum) --> err != nil",
      "err != nil -true-> return 0, err",
      "err != nil -false-> return sum, nil",
      "return 0, nil --> End",
      "return 0, err --> End",
      "return sum, nil --> End"
    ]
  },
  "lua": {
    name: "total", lines: [1,13],
    arrows: [
      "total --> #items == 0",
      "#items == 0 -true-> return 0",
      "#items == 0 -false-> local sum = 0",
      "local sum = 0 --> for _, item in ipairs(items) do",
      "for _, item in ipairs(items) do -loop-> item.price < 0",
      "item.price < 0 -true-> break",
      "item.price < 0 -false-> sum = sum + item.price",
      "sum = sum + item.price -^-> for _, item in ipairs(items) do",
      "break --> local ok, err = pcall(save, sum)",
      "for _, item in ipairs(items) do -done-> local ok, err = pcall(save, sum)",
      "local ok, err = pcall(save, sum) --> not ok",
      "not ok -true-> error(err)",
      "not ok -false-> return sum",
      "return 0 --> End",
      "return sum --> End",
      "error(err) -throws-> End"
    ]
  },
  "gdscript": {
    name: "total", lines: [1,13],
    arrows: [
      "total --> items.is_empty()",
      "items.is_empty() -true-> return 0",
      "items.is_empty() -false-> var sum := 0",
      "var sum := 0 --> for item in items:",
      "for item in items: -loop-> item.price < 0",
      "item.price < 0 -true-> break",
      "item.price < 0 -false-> sum += item.price",
      "sum += item.price -^-> for item in items:",
      "break --> var error := save(sum)",
      "for item in items: -done-> var error := save(sum)",
      "var error := save(sum) --> error != OK",
      "error != OK -true-> push_error(\"save failed\")",
      "push_error(\"save failed\") --> return -1",
      "error != OK -false-> return sum",
      "return 0 --> End",
      "return -1 --> End",
      "return sum --> End"
    ]
  },
  "ruby": {
    name: "total", lines: [1,15],
    arrows: [
      "total --> items.empty?",
      "items.empty? -true-> return 0",
      "items.empty? -false-> sum = 0",
      "sum = 0 --> for item in items",
      "for item in items -loop-> item.price < 0",
      "item.price < 0 -true-> break",
      "item.price < 0 -false-> sum += item.price",
      "sum += item.price -^-> for item in items",
      "break --> save(sum)",
      "for item in items -done-> save(sum)",
      "save(sum) -exception-> rescue IOError => error",
      "rescue IOError => error --> log(error)",
      "log(error) --> raise",
      "save(sum) --> sum",
      "sum --> End",
      "return 0 --> End",
      "raise -throws-> End"
    ]
  },
  "php": {
    name: "total", lines: [2,16],
    arrows: [
      "total --> (count($items) === 0)",
      "(count($items) === 0) -true-> return 0;",
      "(count($items) === 0) -false-> $sum = 0;",
      "$sum = 0; --> foreach ($items as $item)",
      "foreach ($items as $item) -loop-> ($item->price < 0)",
      "($item->price < 0) -true-> break;",
      "($item->price < 0) -false-> $sum += $item->price;",
      "$sum += $item->price; -^-> foreach ($items as $item)",
      "break; --> save($sum);",
      "foreach ($items as $item) -done-> save($sum);",
      "save($sum); -exception-> catch (IOException $error)",
      "catch (IOException $error) --> log_error($error);",
      "log_error($error); --> throw $error;",
      "save($sum); --> return $sum;",
      "return 0; --> End",
      "return $sum; --> End",
      "throw $error; -throws-> End"
    ]
  }
};
