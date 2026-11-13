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
  - Most of the panels work from the keyboard and have labels: My Blueprint, Details, the graph tabs,
    and the Codebase Map, which has arrow-key navigation, menus and announcements.
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
