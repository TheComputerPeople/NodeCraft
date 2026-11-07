import { greet } from './graphs/Greeting.vgraph';

export { greet };

if (require.main === module) {
  console.log(greet('ada'));
}
