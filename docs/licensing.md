# Licensing

How NodeCraft is licensed, why, and what has been put in place so a later version can move to the
Functional Source License (FSL) if that's ever wanted. This is the project's own record; it isn't
legal advice, and a lawyer should review the terms before anything depends on them commercially.

## The terms now

From 0.1.2, NodeCraft is under the GNU General Public License, version 3 only
([LICENSE](../LICENSE)), with two additional permissions ([LICENSING.md](../LICENSING.md)). The
copyright holder is TheComputerPeople. Versions up to 0.1.1 were released under the MIT License, and
stay usable under it by anyone who has them; the change applies from 0.1.2 on.

| Piece | What it does |
|---|---|
| GPL-3.0, version 3 **only** | Anyone may use, study, change and share NodeCraft, but a version they distribute must come with its source under the same terms, so nobody can take it and close it. "Only" rather than "or later" keeps the choice of any future license with the copyright holder rather than with whatever the Free Software Foundation publishes next. |
| Output Exception | What NodeCraft writes into a project (generated code, support code, build lines, New Project's files) is the user's to use under any terms. Without it, users could fear the GPL reaches their programs. It doesn't let a competing code generator reuse NodeCraft's templates or runtime code. |
| Language Pack Exception | Packs that add languages through the public API, the pack formats or the pack SDK may have any license, and may bundle the SDK's helpers. It covers packs only, not other uses of NodeCraft's code. |
| The name | LICENSING.md says the name and logo aren't licensed (GPL section 7(e)): a fork needs its own name. Registering NodeCraft as a trademark would make that stronger. |
| CLA ([CLA.md](../CLA.md)) | Contributors keep their copyright but license it broadly, including for relicensing, so the copyright holder can still offer other terms for the whole codebase. |

The pack SDK (`packages/pack-sdk`) is under the same terms, and `scripts/build-sdk.js` copies the
license files into it. `examples/c-language-pack` is an example extension under the MIT License, so
pack authors can start from it freely.

## Why a CLA

Without one, each contributor owns their part outright under the GPL, and the codebase can only
ever be relicensed with every one of them agreeing. With it, the copyright holder can:

- release later versions under another license (the FSL, say);
- sell commercial licenses to companies that can't accept the GPL (dual licensing);
- enforce the license against copies.

Section 4 of the CLA is the promise that makes it fair to contributors: every contribution stays
available as open source, either under an OSI-approved license or under one that becomes one within
four years (the FSL becomes MIT or Apache-2.0 after two).

## Setting up the CLA bot

`.github/workflows/cla.yml` runs the CLA Assistant action (pinned to v2.6.1's commit). On each pull
request it checks whether the author has signed, asks them to comment the signing sentence if not,
and records signatures in `signatures/cla.json` on a branch of their own. Once the repository is on
GitHub:

1. Create the branch the signatures go on, empty, so it never holds code:
   `git switch --orphan cla-signatures`, `git commit --allow-empty -m "CLA signatures"`,
   `git push origin cla-signatures`, `git switch nodecraft` (or the branch you were on).
2. In the repository's Settings, under Actions, General, set "Workflow permissions" to "Read and
   write permissions" so the action can comment and record signatures.
3. If `main` has branch protection, add the "CLA" check as required, so a pull request can't be
   merged unsigned.

The repository owner's account is on the allow list and never asked to sign. Keep the signatures:
they're the record that a later relicensing is allowed.

## Groundwork for the FSL

The FSL (fsl.software) lets anyone use, change and share the code for any purpose except a
competing commercial product, and turns each version into MIT or Apache-2.0 two years after its
release. A move to it would apply to new versions only: every version released under the GPL stays
under the GPL, and anyone may keep forking those.

What keeps that move possible, and what checks it:

- **Every contribution is under the CLA.** Until the first outside contribution, all of the code is
  the copyright holder's. After that, the CLA bot's record is what shows each contributor agreed.
  Before relicensing, check every author in `git log` is the owner or in `signatures/cla.json`.
- **No GPL-only third-party code.** A component available only under the GPL, LGPL or AGPL would tie
  NodeCraft to the GPL. `scripts/licenses.js` lists the licenses allowed; `npm run package` refuses
  a package with any other module in it, and `test/unit/licensing.test.ts` checks the production
  dependencies. elkjs is offered under EPL-2.0 or GPL-3.0-or-later, and NodeCraft uses it under the
  EPL-2.0 ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)), which works under either license.
- **The exceptions have FSL counterparts.** The FSL forbids only competing uses, so packs are already
  fine under it. The Output Exception's promise (generated code is the user's) has to be kept as an
  explicit statement next to the FSL text, since users rely on it.
- **One place names the license.** `package.json` (extension and SDK) points to LICENSING.md, and
  the README's License section summarizes it, so a change is: replace LICENSE with the FSL text,
  rewrite LICENSING.md, the README section and this page, and add a CHANGELOG entry saying from which
  version the FSL applies.

The FSL comes in two forms, FSL-1.1-MIT and FSL-1.1-ALv2 (Apache-2.0, which adds a patent grant). The
CLA's patent license (section 3) works with either.
