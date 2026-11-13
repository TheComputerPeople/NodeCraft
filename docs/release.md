# Release

Phase 14 of the [roadmap](roadmap.md): what a first-time user needs and what is still missing before
release. Marketplace packaging stays deferred until the platform is complete and robust (decided
2026-10-28), so it isn't part of this plan.

## Where things stand

- **Docs.** The README describes every feature, but parts of it are out of date: Run is described as
  "the project's own Node.js or Python", and step 5 of "Open and run" names three toolchains of
  twelve. The design documents under docs/ are written for this project's developers; a user has no
  page that starts from what they already know.
- **Settings.** There are seven. Two descriptions are out of date: `runCommands` names only Node.js
  and Python, and `defaultLanguage` lists eight of the twelve languages. Nothing lists them together.
- **Unreal.** [unreal-conventions.md](unreal-conventions.md) maps Unreal's gestures and shortcuts. No
  page maps Unreal's concepts (Blueprint classes, the Construction Script, Event BeginPlay,
  BlueprintCallable, Timelines, Actors and Components) to what they are here, or says which don't
  apply.
- **Onboarding.** New Project writes a project in any of the twelve languages, with a graph that
  prints "Hello from Blueprint". Nothing goes further: a new user has to find Variables, Branch,
  functions, Simulate with breakpoints, tests and Debug from the README. VS Code's Getting Started
  page has no walkthrough for the extension.
- **Keyboard and screen readers.**
  - Most of the panels work from the keyboard and have labels: Details, the graph tabs, and the
    Codebase Map, which has arrow-key navigation, menus and announcements. (My Blueprint and the
    palette were thought to be among them; step 6 found they weren't, and fixed them.)
  - The graph itself doesn't. Nodes and pins can't be focused, so a graph can't be built without a
    mouse:
    - the Add Node menu's results are chosen with the mouse only;
    - the node, pin and comment menus open only on a right-click;
    - wires are made only by dragging.
  - A screen reader hears nothing for a node or a pin, and nothing when a wire is made or a node
    added.
  - The arrow keys already nudge the selected nodes, and Delete, F2, Ctrl+D, F7, F9 and F12 work on
    the selection.

## Decisions

Recommended. They're confirmed when the user says so, and the plan follows them.

1. **The onboarding sample is one project, offered in every language.** New Project asks whether to
   start from Hello or from a **Tour**:
   - The Tour graph is the same in every language: events, a variable, Branch, a loop, a function, a
     struct, Print, and a Test Case.
   - Its comments say what to try: Simulate with a breakpoint, hover a pin, Run, Run Tests, Debug.
   - It's tested in the twelve languages as New Project's Hello is (built, checked, run).

   The other way would be a committed sample folder per language: twelve copies of the same graph to
   keep up to date.
2. **A walkthrough on VS Code's Getting Started page.** Its steps:
   - Make a project (the Tour);
   - Compile and Run;
   - Simulate with breakpoints;
   - Debug;
   - Your Code as Nodes;
   - the Codebase Map;
   - Coming from Unreal.

   Each step has a button that runs its command.
3. **The keyboard works as right-click and drag do, at the focus.**
   - The canvas is one focusable element whose active node or pin is announced, as the Codebase Map
     does it.
   - Arrow keys move between nodes, to the nearest one in that direction. Ctrl+arrows nudge the
     selection, as the arrows do now. Enter goes into a node's pins, and Escape comes back out.
   - Shift+F10 and the Menu key open the menu a right-click would open there:
     - on empty canvas, the Add Node menu at the view's center;
     - on a node, the node's menu;
     - on a pin, the pin's menu.
   - A pin's menu gains **Connect to**, which lists the compatible pins of the graph by node and pin.
     It also gains **Add Node from Here**, which opens the Add Node menu as dropping a wire on the
     canvas does.
   - Every menu works with the arrow keys, Enter and Escape.

   The other way would be picking a pin up and dropping it on another, which is closer to dragging
   but harder to follow with a screen reader.
4. **What a screen reader says:**
   - a node: its title, its kind, and its problems;
   - a pin: its name, its type, which way it goes, and what it's connected to, or its value;
   - each change, through a live region: added, connected, deleted, and the compile result.

   Forced colors (high-contrast themes) keep wires, pins and the selection visible.

## Steps

1. This plan.
2. **Settings and README.**
   - Every setting's description is accurate.
   - The README gets a Settings section and an up-to-date Run section for the twelve languages.
   - A "Where to start" list near the top links the guides.
3. **Coming from Unreal** (docs/coming-from-unreal.md).
   - Every Unreal Blueprint concept, with its equivalent here.
   - The ones that don't apply (engine features: Actors, Components, levels, Tick, replication), and
     what to use instead where there's something.
   - A unit test checks that each node and command it names exists.
4. **The Tour.**
   - New Project's Tour graph in the twelve languages.
   - It's tested as Hello is: built, checked and run, with its tests run in each language and in
     Simulate.
5. **The walkthrough** (`contributes.walkthroughs`): its steps, their media, and the commands they
   run. An integration test checks that each step's command exists.
6. **Menus from the keyboard.**
   - Shift+F10 and the Menu key open the menu at the focus.
   - The Add Node menu's results are a listbox chosen with the arrow keys and Enter, which also fixes
     the deferral from Phase 10 (keyboard navigation in the Add Node menu).
   - The node, pin and comment menus work with the arrow keys, Enter and Escape.
7. **Nodes and pins from the keyboard.**
   - The canvas's focus moves across nodes and their pins.
   - A pin's menu gets Connect to and Add Node from Here.
   - Inline values can be edited from the pin.
   - Focus is visible.
8. **Screen readers and forced colors.**
   - Labels for nodes and pins, and the live region's announcements.
   - Every control in the editor has an accessible name, checked by a webview test.
   - Forced-colors styles.
9. **Exit check.**
   - A webview test builds a graph from the keyboard alone: it adds nodes, connects them, sets a
     value, compiles, and finds every step announced.
   - The Tour runs in all twelve languages.
   - The README and the walkthrough are read through as a new user would read them.

## Built (step 2)

- **Settings** (package.json): each description says what the setting does now.
  - `runCommands` lists the default command of each of the twelve languages, and says Run Tests and
    Debug use it too.
  - `defaultLanguage` lists all twelve language ids.
  - `runArguments` says Debug passes the arguments too, as they are.
  - `scanLimit` says the Codebase Map uses it.
  - `compileOnSave` says what compiles when it's off.
  - Restricted Mode's description says what works there.
- **README:**
  - The opening says what the extension is, and a "Where to start" list follows it.
  - A new "Run, Simulate and Debug" section has, for each language, what Run and Debug need.
  - A new Settings section lists every setting with its default.
  - Run and Run Tests are no longer described as Node.js and Python only, node files' snippets as
    three languages, or the project as an MVP.
- **Tests** (unit, settings-docs.test.ts):
  - every setting is in the README's table with its default, and the table lists no others;
  - every setting has a description;
  - `defaultLanguage` names every built-in language.

## Built (step 3)

- **Coming from Unreal** (docs/coming-from-unreal.md), linked from the README's "Where to start"
  and from unreal-conventions.md. It covers:
  - the big difference: generated code and the project's own toolchain, where Unreal has bytecode
    and the VM;
  - each asset New Graph offers;
  - the editor's panels;
  - events and entry points: BeginPlay and the Construction Script are Start, and Tick doesn't
    apply;
  - the nodes whose names or meanings differ;
  - variables and types;
  - functions, macros and classes;
  - reflection: `UFUNCTION`, `UPROPERTY`, `Blueprintable`, native and implementable events, and
    meta tags, each as its `@blueprint` tag;
  - debugging;
  - what doesn't apply, with what to use instead.
- **Checked against the code while writing it:**
  - arrays are references, as in Unreal; only the functions that rearrange one return a new array;
  - an index out of range stops the run;
  - `int`'s size is the language's;
  - Instance Editable and Expose on Spawn aren't here yet, so the guide says so.
- **Tests** (unit, coming-from-unreal.test.ts):
  - every node the Nodes table names is a built-in node, or one made for each class, struct or enum
    (Construct, Cast To, Switch on);
  - the events and other nodes the guide names are nodes;
  - every **Blueprint Visual Scripting:** command it names exists;
  - the Assets table has each kind New Graph offers;
  - every `@` tag it names is read by the scanners.

## Built (step 4)

- **The Tour** (src/extension/tour.ts): a class graph named Main, so each language's entry point
  runs it, with a `Summary` structure in its own file beside it.
  - Start prints a welcome, then a For Loop from 1 to 5 prints each number through a pure function,
    Describe ("1 is odd"), and adds it to a Total variable.
  - Then it prints a Make Summary (`{"Count":5,"Total":15}`) and branches on Total > 10.
  - A Test Case asserts Describe's text for 4 and 7.
  - Four comment boxes say what to try: Run or Simulate; a breakpoint on the loop's Print, hovering
    and stepping, and Debug; the structure; Run Tests and Simulate Tests.
  - Its layout was checked in the webview, so no wire runs backwards.
- **New Project** asks whether to start from the Tour or from Hello.
  - `createProject` writes and compiles every graph of the project. Their types are registered
    first, as the workspace knows them, and the build registration lists every generated file.
  - The project's README says how to use the Tour.
- **Found by the integration test:** New Project compiled the graph before the workspace had
  scanned the structure beside it, so the editor reported "Unknown node type struct:Summary.make".
  `GraphLibraries.update` now reads the project's graph files first.
- **Run's setup** (src/extension/run-setup.ts): what Run, Run Tests and Debug need besides the
  generated file was moved out of compile-service.ts, free of the vscode API, so tests run a project
  as Run does. That covers import roots, the sources built with it, the crate, the Go module and the
  Godot project.
- **Tests:**
  - unit (tour.test.ts):
    - the Tour and its structure pass the graph-file check;
    - Simulate prints the Tour's lines, and Simulate Tests passes;
    - both graphs compile without problems in all twelve languages;
    - New Project writes the Tour only when asked.
  - conformance (new-project.test.ts): in each of the twelve languages, the Tour's project builds and
    passes its checkers, its entry point prints the Tour's lines, and its Test Case passes when run as
    Run Tests runs it (`dotnet build -warnaserror`, clippy, mypy `--strict`, PHPStan level 9, ...).
  - integration: New Project with the Tour in TypeScript writes both graphs and their generated
    files, and Compile in the editor reports no errors.

## Built (step 5)

- **The walkthrough** (package.json `walkthroughs`, media in walkthrough/): **Get Started with
  Blueprint Visual Scripting**, featured for workspaces with `.vgraph` files. It has seven steps, each
  with a Markdown page beside it:

  | Step | Its button | Done when |
  |---|---|---|
  | Make a project | New Project, and Set Up in This Project | New Project or New Graph runs |
  | Compile and Run | Open a Graph | a graph runs |
  | Simulate, with breakpoints | none | Simulate pauses at a breakpoint |
  | Debug in your language | none | a Debug session starts |
  | Your code as nodes | Expose Functions as Nodes | it runs |
  | See the whole codebase | Show Codebase Map | it runs |
  | Coming from Unreal | Open the Guide | it runs |

- **Steps done by doing them:** Run sets `blueprintVisualScripting.hasRun`, a started Debug session
  sets `hasDebugged`, and pausing at a breakpoint sets the existing `debugPaused`. The editor's own
  buttons don't run commands, so these context keys mark the steps done.
- **Blueprint Visual Scripting: Coming from Unreal** opens docs/coming-from-unreal.md in the Markdown
  preview.
- **Tests** (integration):
  - every `command:` link in a step and every `onCommand` completion event is a registered command;
  - every step's media file exists;
  - the walkthrough opens;
  - Coming from Unreal opens the guide in the Markdown preview.

## Built (step 6)

- **Shift+F10 and the Menu key** on the graph open the menu a right-click would, for what's selected
  (`showMenuAtSelection`, menus.ts):
  - the selected node's menu, beside it;
  - the selected comment's, at its title;
  - with nothing selected, Add Node at the view's center.

  The browser's own context menu event that follows is cancelled, so VS Code's doesn't open too.
  Elsewhere, such as My Blueprint's items, that event opens the item's own menu, as a right-click
  does.
- **The Add Node menu** is a combobox over a listbox of results.
  - The arrow keys and Page Up and Page Down move the active result
    (`aria-activedescendant`, `aria-selected`), and show its code.
  - Enter adds it: the first result, until the keys move.
  - Escape closes the menu. The search field used to keep Escape from the graph.
  - This closes Phase 10's deferral (keyboard navigation in the Add Node menu).
- **The node and comment menus, and the floating menus** (My Blueprint's items, the graph tabs,
  Override) are ARIA menus:
  - focus starts on the first item, and the arrow keys, Home and End move;
  - Enter and Space act;
  - Escape and Tab close, and focus goes back where it was.

  The floating menus used to act only on a mouse press.
- **My Blueprint's items** weren't focusable; they are now.
  - Tab reaches them; Enter or Space opens a graph or selects a variable or dispatcher.
  - F2 renames, and Delete deletes the item.
  - The item keeps focus when the panel redraws.
- **The palette's buttons** add their node with Enter. They used to act only on a mouse press.
- **Found by the suite:** a press on the graph didn't take focus from a panel, because the canvas's
  gestures cancel the press's default. With focus left on a My Blueprint item, Delete would have
  deleted the item rather than the nodes just selected. A press anywhere on the graph now takes the
  keyboard from the panels.
- **Tests** (webview, keyboard.test.ts):
  - Shift+F10 opens Add Node; typing, the arrow keys and Enter add Branch; Escape closes;
  - the Menu key on a selected node opens its menu; Down, End and Home move, and Enter on Duplicate
    duplicates; Escape closes it without a change;
  - a My Blueprint item takes focus, and its menu works from the keyboard and gives focus back;
    Enter selects it, and it keeps focus through the redraw;
  - after a press on a node, Delete deletes the node, not the focused item;
  - a palette button adds its node with Enter.
