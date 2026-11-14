# Contributing to NodeCraft

Bug reports, ideas and pull requests are welcome at
[github.com/TheComputerPeople/NodeCraft](https://github.com/TheComputerPeople/NodeCraft).

## The Contributor License Agreement

Before a pull request can be merged, its author signs the
[NodeCraft Contributor License Agreement](CLA.md), once, by commenting on the pull request:

> I have read the CLA Document and I hereby sign the CLA

A bot asks for this on your first pull request and records your signature. You keep the copyright
in what you contribute; the agreement lets the project use it under NodeCraft's license now, and
under other licenses later, while keeping every contribution available as open source (section 4 of
the agreement). [docs/licensing.md](docs/licensing.md) explains why.

## Licenses of what you add

NodeCraft is licensed under the GNU General Public License, version 3 only, with two additional
permissions ([LICENSING.md](LICENSING.md)). Code you contribute is under the same terms.

Code from elsewhere needs a license that allows NodeCraft to use it under those terms and under the
others the agreement allows: MIT, BSD, ISC, Apache-2.0, or a dual license that offers one of these
or the EPL-2.0 (as elkjs does). Code available only under the GPL, LGPL or AGPL can't be added: it
would tie NodeCraft to the GPL. Say where any such code came from in the pull request, and add its
notice to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Building and testing

[README.md](README.md) ("Run it from source" and "Development") lists the commands. Before a pull
request, run `npm run check` and `npm test`, and the conformance tests for any language you change.
