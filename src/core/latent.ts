// Latent actions (docs/program-structure.md, "Latent actions"): Delay and Retriggerable Delay. As
// in Unreal, a latent node suspends only the chain after it: the node returns at once (a
// Sequence's next output runs), and its Completed output runs when the time is up. While a Delay is
// pending, running it again does nothing; a Retriggerable Delay starts its countdown over.
import { NodeDefinition, PinDefinition } from './model';

export const DELAY = 'core:latent.delay';
export const RETRIGGERABLE_DELAY = 'core:latent.retriggerable-delay';

const COLOR = '#5a5a5a';
const execIn: PinDefinition = { id: 'execIn', name: '', kind: 'exec', direction: 'input' };
const completed: PinDefinition = { id: 'completed', name: 'Completed', kind: 'exec', direction: 'output' };
const duration: PinDefinition = { id: 'duration', name: 'Duration', kind: 'data', direction: 'input', type: { id: 'float' }, defaultValue: 0.2 };

export function latentDefinitions(): NodeDefinition[] {
  return [
    {
      type: DELAY, version: 1, displayName: 'Delay', category: 'Flow', color: COLOR, keywords: ['delay', 'wait', 'sleep', 'timer', 'latent'],
      description: 'Runs Completed after Duration seconds. While it is waiting, running it again does nothing.',
      inputs: [execIn, duration], outputs: [completed], implementation: { kind: 'native', operation: 'delay' }, latent: true
    },
    {
      type: RETRIGGERABLE_DELAY, version: 1, displayName: 'Retriggerable Delay', category: 'Flow', color: COLOR, keywords: ['delay', 'retrigger', 'debounce', 'wait', 'latent'],
      description: 'Runs Completed after Duration seconds. Running it again while it is waiting starts the countdown over.',
      inputs: [execIn, duration], outputs: [completed], implementation: { kind: 'native', operation: 'retriggerable-delay' }, latent: true
    }
  ];
}
