# Coming from Unreal

The gestures, shortcuts, pin colors and node styles are Unreal's. Some of the concepts move:

| Unreal | Here |
|---|---|
| Event BeginPlay, Construction Script | **Start** |
| Blueprint VM | Your language's toolchain runs the generated code |
| `UFUNCTION(BlueprintCallable)` | `@blueprint` in a documentation comment |
| `BlueprintPure` | `@blueprint pure` |
| Print String | **Print**, to the Output panel |
| Construct Object from Class | **Construct** |
| Event Tick, Actors, levels | Don't apply: there's no engine |

The guide goes through every concept, and says which don't apply and what to use instead.
