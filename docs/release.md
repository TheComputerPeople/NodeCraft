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
  - every **NodeCraft:** command it names exists;
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
  NodeCraft**, featured for workspaces with `.vgraph` files. It has seven steps, each
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

- **Steps done by doing them:** Run sets `nodecraft.hasRun`, a started Debug session
  sets `hasDebugged`, and pausing at a breakpoint sets the existing `debugPaused`. The editor's own
  buttons don't run commands, so these context keys mark the steps done.
- **NodeCraft: Coming from Unreal** opens docs/coming-from-unreal.md in the Markdown
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

## Built (step 7)

- **The canvas is one focusable element** (src/webview/keyboard.ts). It's an `application` with the
  role description "graph". Its focus is a node, or a pin of one, named through
  `aria-activedescendant`.
  - Tab reaches it. The keyboard starts on the node it was last on, else the selected node, else
    the top-left one.
  - A press on the graph takes focus there too, onto the node or pin pressed, which replaces step 6's
    blur.
  - The ring shows only while the keyboard is in use: Tab or a key, not a click.
- **The arrow keys** move to the nearest node in their direction. They measure between the nodes'
  centers, counting distance across the direction twice, so a node straight ahead wins. Focus
  selects the node, so Delete, F9, F12, Ctrl+D and Shift+F10 act on it, and the view pans just enough
  to show it.
- **Ctrl+arrows nudge the selection**, which the arrows alone used to do (Epic's convention).
  unreal-conventions.md and the README say so.
- **Pins:**
  - Enter goes into a node's pins, and the arrow keys move between them. Up and Down move along a
    side; Left and Right cross sides at the same row.
  - Escape comes back to the node. Escape on a node leaves nothing focused or selected, so Shift+F10
    opens Add Node.
  - F2 on an input edits its value on the node, and Enter or Escape gives the keyboard back to the
    pin.
- **A pin's menu** opens with Enter, Shift+F10 or a right-click. Above the pin's own actions it has
  two that stand in for dragging a wire:
  - **Connect to…** lists, nearest node first, the pins Unreal's rules let it wire to (a number to
    text through a To String), as "Node: Pin", and wires the one chosen;
  - **Add Node from Here…** opens Add Node with the nodes that fit the pin, as dropping a wire on the
    graph does.

  `connectPins` (actions.ts) is the one way both drags and the keyboard wire two pins.
- **Found by the tests:** the Add Node menu focused its search field only on the next frame, so keys
  typed at once after opening it from the keyboard were lost. It focuses the field at once, and
  again after the frame.
- **Tests** (webview, keyboard-graph.test.ts):
  - Tab starts on the top-left node, and the arrows move and select without changing the graph;
  - Enter, the arrows and Escape move through Branch's pins;
  - Add Node from Here on Print's exec output adds Flip Flop wired to it;
  - Connect to on Print's Value lists Add's Result and wires it;
  - F2 edits Add's B and gives the keyboard back;
  - Escape on a node lets Shift+F10 open Add Node;
  - a click puts the keyboard on the node, without the ring.

  editing.test.ts's pin menus now start with Connect to, and interactions.test.ts nudges with
  Ctrl+arrows.

## Built (step 8)

- **Nodes** (render.ts) are groups with the role description "node". Each is labelled with its
  title, what kind it is (event, flow control, function, pure function, get or set variable), its
  breakpoint, "paused here", and its problems ("error: ...").
- **Pins** are labelled with their name and their type and direction ("bool input", "exec output").
  The label goes on with what they're wired to ("connected to Add: Result"), the value they have on
  the node ("value 20"), or "not connected". An exec pin with no name is Exec or Then.
- **Announcements:** the status line is a polite `status` live region, so what it says is read out.
  - Adding a node says "Added Branch.", and adding one from a pin adds ", connected to ...".
  - Wiring says "Connected Add: Result to Print: Value.", output first, from a drag or Connect to,
    noting a To String conversion when there is one.
  - Deleting says "Deleted 2 nodes.".
  - The compile result was already there.

  A node added from the keyboard gets the keyboard's focus.
- **Menus** are named by their title, or "Actions" for the floating ones.
- **Forced colors** (Windows High Contrast) have a `@media (forced-colors: active)` block:
  - nodes have a border, and wires take the system's text color;
  - exec pins keep their arrow, since a forced background would have hidden it;
  - selection, the keyboard's focus and hovered wires use Highlight;
  - badges and breakpoints stay visible.

  The focused pin's ring goes around its row, in either mode: an exec pin's arrow clips a ring of its
  own, which hid it in step 7.
- **Tests** (webview, accessibility.test.ts):
  - Chromium's own accessibility tree (over CDP) has no unnamed interactive element. That was checked
    with the event graph, a node selected, a node menu, Add Node, a variable's details and its menu,
    and a function's graph. It found the unnamed node menu, now named.
  - The labels of Branch, a wired Value, B's value and Start's exec output are checked, and the
    canvas's `aria-activedescendant` names the focused node.
  - The status line says "Added Flip Flop.", "Connected ... to Flip Flop: Exec.", "Deleted 1 node." and
    "Compile failed: 1 error", and the node's label carries the error.
  - In emulated forced colors, nodes have a solid border, exec pins a fill, wires a stroke, and the
    focused pin's row and the selected node a solid outline.

## Built (step 9): the exit check

- **A graph built from the keyboard alone** (webview, keyboard-only.test.ts). The test starts from a
  class with only Start and uses no mouse:
  - Tab reaches the graph, which says "Start, event";
  - Add Node from Here adds a Print wired to Start;
  - Escape, then Shift+F10, adds a Branch on its own;
  - Connect to wires Branch's Exec from Print's Then;
  - the arrows go back to Print, and F2 sets its text;
  - F7 compiles.

  Every step is announced on the status line ("Added Print, connected to ...", "Added Branch.",
  "Connected Print: Then to Branch: Exec.", "Compiled to Greeter.vgraph.js"), and the graph saved
  prints the text in Simulate.
- **Found by it:**
  - The graph was hundreds of Tab presses away, because each of the palette's nodes was a stop. The
    palette is now one stop (`role=group`, "Palette"), moved through with the arrow keys, Home, End,
    Page Up and Page Down. The graph is now the 17th stop.
  - A pin's label kept its old value after F2 changed it, since inline edits don't redraw. The label
    now follows the field as it's typed in.
- **The Tour** builds, passes its checkers, runs and passes its test in all twelve languages
  (new-project.test.ts, in the full run).
- **Read through as a new user:**
  - The README didn't say how to get the extension. "Where to start" now says it isn't on the
    Marketplace yet, and "Open and run" is now "Try it from source".
  - The walkthrough's pages and the guide were read through with it.
- **The full suites:**
  - `npm test`: 1,757 tests, 1,754 passing, none failing. That is unit, webview, conformance and the
    corpus. One test is skipped, Linux's and macOS's scratch folder, and two are todo, the corpus's
    luacheck, which isn't installed here.
  - `npm run test:integration:debuggers`: 80/80, 6/6 multi-root, 4/4 Restricted Mode.

## Status

All nine steps are done. Marketplace packaging stays deferred, as decided on 2026-10-28.

Left for later:
- the Codebase Map's own forced-colors pass, beyond its existing keyboard and ARIA support;
- a Favorites list in the palette;
- Instance Editable and Expose on Spawn, which Coming from Unreal lists as not here yet.

## The name: NodeCraft

Renamed on 2026-11-13, before publishing, for GitHub and the Marketplace. "Blueprint Visual Scripting"
is Epic's own name for Unreal's feature.

- **Changed everywhere:**
  - the product's name in every message, panel, command category, generated file header, build-file
    marker, doc and sample;
  - the extension's name (`nodecraft`, so the id is `<publisher>.nodecraft`);
  - the prefix of every command, setting, view, context key and the walkthrough (`nodecraft.*`), so
    the settings are now `nodecraft.compileOnSave` and the like;
  - the pack SDK (`@nodecraft/pack-sdk`, `nodecraft-conformance`) and the C pack example
    (`nodecraft-c-language-pack`);
  - the scratch and test folders, and the corpus tools' cache (`nodecraft-corpus`);
  - the test settings (`NODECRAFT_TEST_BROWSER`, `NODECRAFT_IT_FILTER`, `NODECRAFT_CORPUS_TOOLS`,
    `NODECRAFT_CORPUS_REQUIRE_TOOLS`).
- **The repository** was assumed to be under the local git user's name on GitHub (wrongly; see "The project links removed"): `repository`, `homepage` and `bugs` in
  package.json, and the schemas' `$id`s. That's what lets `vsce` rewrite the README's links.
- **The publisher** is `DevinBrasher` (display name Devin Brasher), so the extension's id is
  `DevinBrasher.nodecraft`. The C pack example uses the same publisher.
- **Kept:** Unreal's own terms for what the editor copies. These are Blueprint Class, Blueprint
  Interface, Blueprint Function and Macro Library, My Blueprint, Blueprint packages, and the
  `@blueprint` marker in code.
- **What was written under the former name is still the extension's own** (former-name.test.ts):
  - a generated file whose header says "Blueprint Visual Scripting" is recognized, so compiles write
    over it and the map shows its graph;
  - a build block whose marker names it is found and given the new marker, not added a second time;
  - Lua's support file under the old name is the extension's.
- The README opens with the project's description, and says NodeCraft isn't affiliated with Epic
  Games.

## 0.1.1: the package fixed

0.1.0 was uploaded to the Marketplace on 2026-11-13 and couldn't activate: "Cannot find module
'web-tree-sitter'".

- **Cause:** package.json still had the `files` list from an early phase, and `vsce` packaged only
  what it named. That left out `node_modules`, which holds the runtime libraries `web-tree-sitter`
  and `elkjs`, and `walkthrough/`, the Getting Started pages. It also put in `src/` and `sample/`.
  Activation loads the parser (extension → Codebase Map service → indexer → parser), so nothing
  worked.
- **Fixed:**
  - `.vscodeignore` replaces `files`. It leaves everything out, then lets in what's used at runtime:
    `dist/`, `grammars/`, `schemas/`, `walkthrough/`, `docs/`, the license files, and the production
    `node_modules`.
  - `vscode:prepublish` builds before every package.
  - The version is 0.1.1, with a CHANGELOG.
  - The README's install line says to get it from the Marketplace.
- **Checks:**
  - `npm run package` ends with `scripts/check-package.js`, which reads the `.vsix` itself. Every npm
    module its code requires and every file package.json points to has to be inside, nothing only
    for development may be, and the parser has to load from the extracted package. On 0.1.0 it
    lists all of the above.
  - `npm run test:package` installs the `.vsix` into a VS Code of its own and checks that the
    installed extension activates, New Project writes the Tour, and the Codebase Map opens. It
    passes on 0.1.1, and on 0.1.0 it fails with the users' error.

## 0.1.2: GPL-3.0, with an output exception and a CLA

Decided 2026-11-14: NodeCraft is open source, but nobody may take it and close it. Copyright stays
with Devin Brasher, and a later move to the Functional Source License stays possible.
[docs/licensing.md](licensing.md) is the full record.

- **Terms:** LICENSE is the GPL-3.0's text, word for word. LICENSING.md names the copyright holder,
  "version 3 only", the name's exclusion (section 7(e)), and two section 7 permissions: the Output
  Exception (what NodeCraft writes into a project is the user's) and the Language Pack Exception
  (packs may have any license). `package.json`, the extension's and the pack SDK's, says
  `SEE LICENSE IN LICENSING.md`. The README has a License section; the SDK's README and package carry
  the same terms.
- **Contributions:** CLA.md licenses each contribution broadly, including for relicensing, and
  promises it stays open source (OSI-approved, or becoming so within four years). CONTRIBUTING.md
  explains it and which third-party licenses can be added. `.github/workflows/cla.yml` runs the CLA
  Assistant action, pinned to v2.6.1's commit, and needs the setup docs/licensing.md describes once
  the repository is on GitHub.
- **Checks:** `scripts/licenses.js` lists the third-party licenses allowed (no GPL-only ones).
  `npm run package` refuses a package with a module under any other, and
  `test/unit/licensing.test.ts` checks the production dependencies, the GPL text's hash, the
  manifests and the CLA sentence.

## The project links removed

The address assumed above ("The name: NodeCraft") was never NodeCraft's repository,
and the Marketplace's Project Details linked to it. On 2026-11-14 the user chose to remove the links
until there's a public repository:

- package.json has no `repository`, `homepage` or `bugs`, and `npm run package` passes
  `--allow-missing-repository` to vsce.
- `scripts/marketplace-readme.js` writes the README the Marketplace shows (`--readme-path`), with
  links to the repository's other files turned into their text, since they'd lead nowhere.
  `check-package.js` refuses a package whose README still has one.
- The schemas' `$id`s are `urn:nodecraft:schema:<name>`. Nothing resolves them.
- The CLA bot takes the repository and its owner from GitHub (`github.repository`,
  `github.repository_owner`), and CLA.md and CONTRIBUTING.md name no address.

To add a repository later, put `repository`, `homepage` and `bugs` back in package.json. The
Marketplace README can then keep its links, since vsce rewrites them to the repository.

Later on 2026-11-14 the user gave the repository: `github.com/TheComputerPeople/NodeCraft` (public,
empty at the time). package.json's `repository`, `homepage` and `bugs` point to it again, so vsce
rewrites the README's links to the repository's files; they work once the code is pushed there.
`scripts/marketplace-readme.js` only turns links into text when package.json names no repository.
The schemas keep their URN `$id`s, and CLA.md still names no address.

## The copyright holder: TheComputerPeople

On 2026-11-14, before the first push to GitHub, the user chose TheComputerPeople, the organization
the repository is under, as NodeCraft's copyright holder instead of Devin Brasher: LICENSING.md, the
README's and the pack SDK's License sections, CLA.md ("We") and docs/licensing.md name it. The
Marketplace publisher is still `DevinBrasher`.
