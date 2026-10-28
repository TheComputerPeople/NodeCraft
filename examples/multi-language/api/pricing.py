"""The pricing service: prints an item's price as JSON.

It stands in for any Python program or service a graph in another language needs; see
../README.md. Run it on its own with `python pricing.py apple`.
"""
import json
import sys

PRICES = {"apple": 0.5, "bread": 2.25, "coffee": 4.0}

if __name__ == "__main__":
    item = sys.argv[1] if len(sys.argv) > 1 else ""
    if item not in PRICES:
        sys.exit(f"No price for {item!r}")
    print(json.dumps({"item": item, "price": PRICES[item]}))
