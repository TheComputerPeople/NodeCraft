// The language pack SDK (docs/language-breadth.md, "The public API and the pack SDK"): what a pack
// author needs to write a language pack, and the conformance suite to check it. Published as
// @blueprint-visual-scripting/pack-sdk; nothing here depends on VS Code.

// The API version packs are written against (a pack sets `apiVersion` to it), and the API the
// extension gives other extensions. A change that breaks packs is a new major version of the SDK
// and of this number.
export { API_VERSION } from '../core/api';
export type { BlueprintVisualScriptingApi, Disposable, NodeLibrary } from '../core/api';

// A language pack and its parts.
export type {
  CodeDebugger, CodeGenerator, CodeRunner, CodeSimulator, GenerateOptions, GeneratedCode, LanguageCapabilities, LanguagePack, PinExpression, RunContext, SymbolImporter
} from '../core/language-pack';
// The Visual IR a generator turns into source code.
export type {
  IrBlock, IrCallee, IrCodeHelper, IrDeclaration, IrDispatcher, IrExpr, IrFunction, IrImport, IrMember, IrPinValue, IrProgram, IrSlot, IrStatement, IrTest, SourceRef
} from '../core/compiler/ir';
export type { Capability, NodeDefinition, PinDefinition } from '../core/model';
export type { TypeRef, ContainerKind } from '../core/types';
export type { NodeLine } from '../core/compiler/writer';
export type { FencedBlock, OutputHook, OutputPlan, PlacementContext } from '../core/output-plan';
export type { NameStyle } from '../core/compiler/names';

// Helpers the built-in packs use.
export { CodeWriter } from '../core/compiler/writer';
export { NameScope, toIdentifier, dedent, claimClassMembers } from '../core/compiler/names';
export { exprType, readsStorageOnly, programClassSpec, userTypes, interfaceInfo } from '../core/compiler/ir';
export { FULL_CAPABILITIES } from '../core/capabilities';
export { findBlock, hasBlock, withBlock } from '../core/output-plan';
export { formatValue } from '../core/values';

// Declarative packs: a definition (schema/language-pack.schema.json in this package) as a pack.
export { declarativePack, loadDeclarativePack, checkDefinition, parseTemplate, renderTemplate, TemplateError } from '../core/declarative';
export type { DeclarativeDebugger, DeclarativePackDefinition, DeclarativeRunner, Template, TemplateValue } from '../core/declarative';

// The conformance suite.
export { runConformance, loadFixtureSet, programFiles, defaultFixtureSet, formatReport } from '../conformance/conformance';
export type { ConformanceOptions, ConformanceReport, Fixture, FixtureResult, FixtureSet, ResultStatus } from '../conformance/conformance';
