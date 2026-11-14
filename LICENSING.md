# NodeCraft license terms

Copyright (C) 2026 Devin Brasher

NodeCraft is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License, version 3 only, as published by the Free Software Foundation (the file
[LICENSE](LICENSE)), with the two additional permissions below.

NodeCraft is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even
the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
Public License for more details.

The additional permissions are given under section 7 of the GNU General Public License, version 3.
They cover the copyright holder's own code in NodeCraft; the third-party components it includes keep
their own licenses ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). If you modify NodeCraft, you
may extend these permissions to your version of it, but you are not obliged to; if you don't wish to,
delete them from your version.

Your graphs, and anything else you write yourself, are yours. These terms make no claim on them.

The name NodeCraft and its logo identify this project. The license gives no permission to use them:
a modified version you distribute needs a name of its own (section 7(e) of the GNU General Public
License). Saying that your work is based on NodeCraft, or works with it, is fine.

## Additional permission 1: the NodeCraft Output Exception, version 1.0

"Output" means material that NodeCraft, or a version of it modified by anyone, writes into a
project in the course of its operation, including:

- source code generated from graphs;
- the support and runtime code written alongside generated code;
- the lines of build configuration added to a project's files between `vgraph:begin` and
  `vgraph:end` marker lines;
- the graphs, node definitions, tests and other files that commands such as New Project write from
  NodeCraft's templates;

and every part of NodeCraft (its templates, runtime code and examples) that such material contains.

You may use, copy, modify and distribute Output, on its own or as part of a larger work, under terms
of your choice. Neither the Output nor the larger work becomes subject to the GNU General Public
License because it contains Output.

This permission doesn't apply to a program that is itself a visual scripting editor, a graph
compiler or a code generator and uses Output, or anything taken from NodeCraft's templates or
support code, as material for what it generates. Such use stays under the GNU General Public License.

## Additional permission 2: the NodeCraft Language Pack Exception, version 1.0

A "language pack" is a program or data file that adds a language, nodes or other features to
NodeCraft through its public interfaces only:

- the API the NodeCraft extension gives other VS Code extensions;
- the declarative language pack format (`*.vgraph-language.json`), node definition files
  (`*.node.json`) and package manifests;
- the NodeCraft pack SDK (`@nodecraft/pack-sdk`), including its conformance suite.

You may write, use and distribute a language pack under terms of your choice. Using the pack SDK in
a language pack (calling it, bundling its helpers into the pack, or checking the pack with its
conformance suite) doesn't make the pack subject to the GNU General Public License.

This permission covers a work only while it is a language pack for NodeCraft. It doesn't allow
NodeCraft's code, from the pack SDK or elsewhere, to be used in any other program under terms other
than the GNU General Public License.

## Contributions

Contributions are accepted under the [NodeCraft Contributor License Agreement](CLA.md). See
[CONTRIBUTING.md](CONTRIBUTING.md), and [docs/licensing.md](docs/licensing.md) for why the project
is licensed this way.
