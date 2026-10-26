# Unreal Blueprint conventions

The Unreal Engine 5 Blueprint editor behaviors this extension copies, so Blueprint users can work without relearning. Each entry notes its source. Where Epic documents a behavior, that is the reference; community-documented behaviors are implemented too but flagged, because users may have rebound them in their own editor.

Sources:
- **Epic:** [Blueprint Editor Cheat Sheet](https://dev.epicgames.com/documentation/en-us/unreal-engine/blueprint-editor-cheat-sheet-in-unreal-engine) (Epic Games documentation).
- **Community:** widely used shortcuts that Epic's cheat sheet doesn't list, for example from [cheatsheets.zip](https://cheatsheets.zip/unreal-engine) and Unreal forum answers. Treat these as "Unreal's usual default".
- **Engine colors:** pin colors come from engine code (`UEdGraphSchema_K2::GetPinTypeColor`) and editor preferences, not a documented table; the values below approximate the defaults.

## Navigation

| Action | Gesture | Source |
|---|---|---|
| Pan | Right-mouse drag (middle-mouse drag also works) | Epic |
| Zoom | Mouse wheel | Epic |
| Zoom to fit the selection (or the whole graph when nothing is selected) | Home | Epic |

## Selection

| Action | Gesture | Source |
|---|---|---|
| Select a node | Click | Epic |
| Add to the selection | Shift + click | Epic |
| Toggle in the selection | Ctrl + click | Epic |
| Marquee select (replace / add / remove) | Drag / Shift + drag / Ctrl + drag on the background | Epic |

## Nodes

| Action | Gesture | Source |
|---|---|---|
| Graph action menu | Right-click the background | Epic |
| Node context menu | Right-click a node | Epic |
| Pin context menu: the pin's actions (Break Link(s), Promote to Variable, Remove Execution Pin) above the node's actions | Right-click a pin | Epic |
| Comment context menu: Rename, Delete (color is set in Details) | Right-click a comment's title bar; its body lets clicks through to the graph | Engine behavior |
| Move | Drag; arrow keys move the selection | Epic |
| Delete | Delete | Epic |
| Cut / copy / paste / duplicate | Ctrl + X / C / V / D | Epic |
| Rename a node or edit a comment | F2, or click the title | Epic |
| Go to the graph a node refers to | Double-click the node | Epic |
| Comment around the selection | C | Epic |
| Place a node | Hold a key and click: B Branch, S Sequence, C Comment, P BeginPlay (our Start), F For Each Loop, G Gate, M MultiGate, N Do N, O Do Once, D Delay | Epic |
| Align (top, middle, bottom, left, center, right), straighten connections | Node context menu → Alignment | Epic (menu) |
| Align top / left / bottom / right | Shift + W / A / S / D | Community |
| Straighten connections | Q | Community |
| Add a reroute node | Double-click a wire | Community |
| Add an element pin to Make Array, Make Set or Make Map; remove one | "Add pin +" on the node; right-click the pin → Remove Element Pin | Epic |
| Wildcard pins take the type of the first wire connected to them | Connect a wire | Engine behavior |
| Refresh Node: update a node whose function's signature changed | Node context menu | Engine behavior |
| Refresh All Nodes | Command Palette → Refresh All Nodes (Unreal: File menu) | Epic (menu) |
| Replace a node whose function was renamed or moved | Node context menu → Replace with … | Ours: Unreal has no equivalent for code nodes |

## Wires and pins

| Action | Gesture | Source |
|---|---|---|
| Connect | Drag from a pin to a pin | Epic |
| Filtered action menu for a pin | Drag from a pin to empty space | Epic |
| Break all connections | Alt + click a pin | Epic |
| Move all connections to another pin | Ctrl + drag from a pin | Epic |
| Highlight a pin's wires | Hover the pin | Epic |
| Wiring rules | An exec output connects to one exec input; an exec input accepts many. A data input accepts one wire; a data output feeds many. | Engine behavior |

## Variables (My Blueprint panel)

| Action | Gesture | Source |
|---|---|---|
| Get node | Ctrl + drag the variable into the graph | Epic |
| Set node | Alt + drag the variable into the graph | Epic |
| Choose Get or Set | Drag the variable into the graph (a menu asks) | Epic |
| Get or Set as appropriate | Drag the variable onto a compatible pin | Epic |
| Call a function | Drag the function from My Blueprint into a graph, or pick it in the action menu | Epic |
| Collapse to Function | Node context menu, with the nodes selected | Epic |
| A function's inputs, outputs, Pure, Description and Category | Details, with the function open (or its entry node selected) | Epic |
| A function's local variables | My Blueprint → Local Variables, with the function open | Epic |

## Editor commands

| Action | Gesture | Source |
|---|---|---|
| Compile | F7 | Epic |
| Save | Ctrl + S | Epic |
| Undo / redo | Ctrl + Z / Ctrl + Y | Epic |
| Find in this Blueprint | Ctrl + F | Epic |
| Find in all Blueprints | Ctrl + Shift + F | Epic |
| Toggle breakpoint / clear all breakpoints | F9 / Ctrl + Shift + F9 | Epic |

On macOS, Ctrl is Cmd and Alt is Option.

## Pin and wire colors

Wires take the color of the pin they leave. Approximations of Unreal's defaults:

| Type | Color | Notes |
|---|---|---|
| Exec | White | Drawn as an arrow, not a circle |
| bool | Dark red `#a01919` | |
| int | Teal green `#1fe3aa` | |
| float | Yellow-green `#9cf24a` | |
| string | Magenta `#f72bc9` | |
| object | Blue `#1f9fef` | `object:<Class>` |
| struct | Dark blue `#1e5fc4` | `struct:<Name>` |
| enum | Dark teal `#106f61` | Unreal colors enums like bytes |
| any, wildcard | Grey `#8c8484` | |
| native | Purple `#a374e5` | Types imported from user code; no Unreal equivalent |

Containers use the element type's color, with the pin drawn as a grid (array), braces (set) or split circle (map), as Unreal does.

## Node title styles

| Node kind | Title style |
|---|---|
| Event (Start) | Red title bar |
| Impure function or code node (has exec pins) | Blue title bar |
| Pure function (no exec pins) | Green title bar |
| Flow control and macros (Branch, Sequence) | Grey title bar |
| Variable Get | Compact: no title bar, colored by the variable's type |
| Variable Set | "SET" title, colored by the variable's type |
