using Corpus.Game.Graphs;

Console.WriteLine(Greeting.Greet("ada"));
new Counting().Start();
new Dividing().Start();
new Firsts().Start();
new Questing().Start();
new Fetching().Start();
// Fetching waits for FetchDouble: its Completed runs with the graphs' other latent actions.
Fetching.RunLatentActions();
