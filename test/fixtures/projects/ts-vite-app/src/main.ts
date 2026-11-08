import { greet } from './graphs/Greeting.vgraph.ts';
import { Counting } from './graphs/Counting.vgraph.ts';
import { Dividing } from './graphs/Dividing.vgraph.ts';
import { Firsts } from './graphs/Firsts.vgraph.ts';
import { Fetching } from './graphs/Fetching.vgraph.ts';

console.log(greet('ada'));
for (const graph of [new Counting(), new Dividing(), new Firsts(), new Fetching()]) graph.start();
