'use strict';
// Each word belongs to exactly one tier; difficulty is a fixed property of the word.
const split = (s) => s.split(/\s+/).filter(Boolean);
const TIERS = {
  easy: split(`apple banana pizza cake cookie bread cheese carrot cat dog fish bird cow pig duck frog snake
    house tree flower sun moon star cloud rain car bus boat ball hat shoe sock book chair table bed door key bell egg heart smile`),
  medium: split(`popcorn icecream horse turtle rabbit mouse lion tiger elephant monkey penguin owl bee spider butterfly shark whale dolphin
    octopus crab snowman rainbow mountain volcano island river beach rocket planet train plane bicycle truck tractor
    lamp clock window umbrella glasses scarf backpack guitar piano drum camera phone computer pencil scissors hammer ladder
    tent ghost robot dragon pirate crown sword shield balloon candle gift kite anchor magnet envelope trophy`),
  hard: split(`trumpet helicopter submarine bridge castle lighthouse wizard treasure
    skateboard waterfall windmill telescope cactus jellyfish kangaroo scarecrow parachute fireworks tornado bagpipes
    chandelier hourglass compass lantern fountain pyramid igloo saxophone unicycle skeleton vampire mermaid
    spaceship rollercoaster drawbridge fossil harp snorkel avalanche`),
};
const MULT10 = { easy: 10, medium: 15, hard: 20 }; // tenths: 1x, 1.5x, 2x
const DIFFS = Object.keys(TIERS);
const WORDS = DIFFS.flatMap((d) => TIERS[d]);
const difficultyOf = (w) => DIFFS.find((d) => TIERS[d].includes(w));
module.exports = { TIERS, MULT10, DIFFS, WORDS, difficultyOf };
