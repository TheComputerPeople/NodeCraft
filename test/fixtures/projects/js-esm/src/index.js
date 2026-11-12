import { greet } from './graphs/Greeting.vgraph.js';
import { Counting } from './graphs/Counting.vgraph.js';
import { Dividing } from './graphs/Dividing.vgraph.js';
import { Firsts } from './graphs/Firsts.vgraph.js';
import { Questing } from './graphs/Questing.vgraph.js';
import { Fetching } from './graphs/Fetching.vgraph.js';

console.log(greet('ada'));
for (const graph of [new Counting(), new Dividing(), new Firsts(), new Questing(), new Fetching()]) graph.start();
